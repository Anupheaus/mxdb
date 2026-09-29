// Test-only (a copy of nexus's own): a software passkey that produces the same registration and sign-in responses a real authenticator does, so
// the server's verification (sc-627) is tested against genuine signatures rather than mocks. Never imported by the
// library's entry points.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import type { WebAuthnAssertionCredentialJson, WebAuthnRegistrationCredentialJson } from '@anupheaus/nexus/common';

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED_CREDENTIAL = 0x40;

const b64url = (bytes: Uint8Array | Buffer | string) => Buffer.from(bytes).toString('base64url');
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest();
const counterBytes = (counter: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(counter); return bytes; };

export interface SoftwarePasskeyOptions {
  rpId: string;
  origin: string;
}

/** What a single ceremony may change, to produce a response a real authenticator or attacker could send. */
export interface CeremonyOverrides {
  origin?: string;
  rpId?: string;
  /** Leave out the user-verified flag, as an authenticator that did not verify the user would. */
  withoutUserVerification?: boolean;
  /** The signature counter to report (default: 0, as Google Password Manager does). */
  counter?: number;
}

export function createSoftwarePasskey({ rpId, origin }: SoftwarePasskeyOptions) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { x, y } = publicKey.export({ format: 'jwk' });
  const credentialId = randomBytes(16);
  // COSE_Key for ES256: kty EC2 (2), alg ES256 (-7), crv P-256 (1), x, y.
  const coseKey = new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(x!, 'base64url')], [-3, Buffer.from(y!, 'base64url')]]);

  const clientData = (type: string, challenge: string, overrides: CeremonyOverrides) =>
    Buffer.from(JSON.stringify({ type, challenge, origin: overrides.origin ?? origin, crossOrigin: false }));
  const flags = (overrides: CeremonyOverrides, extra = 0) =>
    Buffer.from([FLAG_USER_PRESENT | (overrides.withoutUserVerification ? 0 : FLAG_USER_VERIFIED) | extra]);

  return {
    credentialId: b64url(credentialId),

    /** Answers `navigator.credentials.create` for `challengeBytes`. */
    register(challengeBytes: Uint8Array, overrides: CeremonyOverrides = {}): WebAuthnRegistrationCredentialJson {
      const idLength = Buffer.alloc(2); idLength.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([
        sha256(overrides.rpId ?? rpId), flags(overrides, FLAG_ATTESTED_CREDENTIAL), counterBytes(overrides.counter ?? 0),
        Buffer.alloc(16), idLength, credentialId, Buffer.from(isoCBOR.encode(coseKey as never)),
      ]);
      const attestationObject = isoCBOR.encode(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]) as never);
      return {
        id: b64url(credentialId), rawId: b64url(credentialId), type: 'public-key',
        response: { clientDataJSON: b64url(clientData('webauthn.create', b64url(challengeBytes), overrides)), attestationObject: b64url(attestationObject), transports: ['internal'] },
        clientExtensionResults: {}, authenticatorAttachment: 'platform',
      };
    },

    /** Answers `navigator.credentials.get` for `challenge` (base64url, as the server issued it). */
    signIn(challenge: string, overrides: CeremonyOverrides = {}): WebAuthnAssertionCredentialJson {
      const authData = Buffer.concat([sha256(overrides.rpId ?? rpId), flags(overrides), counterBytes(overrides.counter ?? 0)]);
      const clientDataJSON = clientData('webauthn.get', challenge, overrides);
      const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), privateKey);
      return {
        id: b64url(credentialId), rawId: b64url(credentialId), type: 'public-key',
        response: { clientDataJSON: b64url(clientDataJSON), authenticatorData: b64url(authData), signature: b64url(signature) },
        clientExtensionResults: {}, authenticatorAttachment: 'platform',
      };
    },
  };
}
