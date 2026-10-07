import { describe, expect, it } from 'vitest';
import type { NexusDeviceDetails, WebAuthnAuthRecord } from '@anupheaus/nexus/common';
import { toDeviceStatus } from './deviceStatus';

const deviceDetails = { name: 'Pixel 8' } as unknown as NexusDeviceDetails;

describe('toDeviceStatus', () => {
  it.each<[string, Partial<WebAuthnAuthRecord>, string]>([
    ['a fresh invite', { isEnabled: false }, 'pending'],
    ['an invite with null device fields', { isEnabled: false, keyHash: null, deviceDetails: null } as unknown as Partial<WebAuthnAuthRecord>, 'pending'],
    ['an enabled device', { isEnabled: true, keyHash: 'hash', deviceDetails }, 'active'],
    ['an enabled record with nothing else', { isEnabled: true }, 'active'],
    ['a disabled device', { isEnabled: false, keyHash: 'hash', deviceDetails }, 'disabled'],
    ['a key hash but no device details', { isEnabled: false, keyHash: 'hash' }, 'disabled'],
    ['a passkey credential only', { isEnabled: false, credentialId: 'cred' }, 'disabled'],
    ['a connection only', { isEnabled: false, lastConnectedAt: 1 }, 'disabled'],
  ])('%s is %s', (_name, record, status) => {
    expect(toDeviceStatus(record as WebAuthnAuthRecord)).toBe(status);
  });
});
