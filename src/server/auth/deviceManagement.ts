import type { NexusAuthRecord } from '@anupheaus/nexus/common';
import type { AuthCollection } from './AuthCollection';
import type { MXDBDeviceInfo } from '../../common/models';
import { toDeviceStatus } from './deviceStatus';

/**
 * Device management public server APIs.
 *
 * These are plain async functions (not socket actions). The app server calls
 * them from admin routes. They accept an already-initialised `AuthCollection`
 * to avoid creating duplicate collection instances.
 */

export async function getDevices(
  authColl: AuthCollection<NexusAuthRecord>,
  userId: string,
): Promise<MXDBDeviceInfo[]> {
  const records = await authColl.findAllByUserId(userId);
  return records.map(record => ({
    requestId: record.requestId,
    userId: record.userId,
    deviceDetails: record.deviceDetails,
    isEnabled: record.isEnabled,
    lastConnectedAt: record.lastConnectedAt,
    status: toDeviceStatus(record),
  }));
}

export async function enableDevice(
  authColl: AuthCollection<NexusAuthRecord>,
  requestId: string,
): Promise<void> {
  // One conditional write: only a disabled device is enabled, and its old session token goes (sc-613). A disabled device
  // keeps it so its connections are told why, but re-enabling must not bring it back to life; the device signs in again
  // with its passkey. An already-enabled device keeps its current session.
  await authColl.enableIfDisabled(requestId);
}

export async function disableDevice(
  authColl: AuthCollection<NexusAuthRecord>,
  requestId: string,
): Promise<void> {
  await authColl.update(requestId, { isEnabled: false });
}

export async function deleteDevice(
  authColl: AuthCollection<NexusAuthRecord>,
  requestId: string,
): Promise<void> {
  await authColl.delete(requestId);
}

/**
 * Deletes the device only while it is still a pending invite (one conditional write), and resolves whether it did. Use it
 * to retire invites: a device that registered after it was listed is never deleted.
 */
export async function deletePendingInvite(
  authColl: AuthCollection<NexusAuthRecord>,
  requestId: string,
): Promise<boolean> {
  return authColl.deletePendingInvite(requestId);
}

/** Deletes pending invites older than `ttlMs` in one write (an invite registering meanwhile is kept), returning how many. */
export async function expireStalePendingInvites(
  authColl: AuthCollection<NexusAuthRecord>,
  ttlMs: number,
): Promise<number> {
  return authColl.deleteStalePendingInvites(Date.now() - ttlMs);
}
