import { isPendingWebAuthnInvite, type WebAuthnAuthRecord } from '@anupheaus/nexus/common';
import type { MXDBDeviceStatus } from '../../common/models';

/** The fields that decide a device's status; a Google OAuth record simply has no key hash or passkey credential. */
type DeviceStatusFields = Pick<WebAuthnAuthRecord, 'isEnabled'> & Partial<Pick<WebAuthnAuthRecord, 'keyHash' | 'credentialId' | 'deviceDetails' | 'lastConnectedAt'>>;

/**
 * A device's status, from nexus's one definition of a pending invite (`isPendingWebAuthnInvite`): a record that has never
 * registered is `pending`; a registered one is `active` while enabled and `disabled` otherwise.
 */
export function toDeviceStatus(record: DeviceStatusFields): MXDBDeviceStatus {
  if (isPendingWebAuthnInvite(record)) return 'pending';
  return record.isEnabled === true ? 'active' : 'disabled';
}
