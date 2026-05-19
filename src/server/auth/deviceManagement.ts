import type { SocketAPIAuthRecord } from '@anupheaus/nexus/common/auth';
import type { AuthCollection } from './AuthCollection';
import type { MXDBDeviceInfo } from '../../common/models';

/**
 * Device management public server APIs.
 *
 * These are plain async functions (not socket actions). The app server calls
 * them from admin routes. They accept an already-initialised `AuthCollection`
 * to avoid creating duplicate collection instances.
 */

export async function getDevices(
  authColl: AuthCollection<SocketAPIAuthRecord>,
  userId: string,
): Promise<MXDBDeviceInfo[]> {
  const records = await authColl.findAllByUserId(userId);
  return records.map((r: SocketAPIAuthRecord) => ({
    requestId: r.requestId,
    userId: r.userId,
    deviceDetails: r.deviceDetails,
    isEnabled: r.isEnabled,
    lastConnectedAt: r.lastConnectedAt,
  }));
}

export async function enableDevice(
  authColl: AuthCollection<SocketAPIAuthRecord>,
  requestId: string,
): Promise<void> {
  await authColl.update(requestId, { isEnabled: true });
}

export async function disableDevice(
  authColl: AuthCollection<SocketAPIAuthRecord>,
  requestId: string,
): Promise<void> {
  await authColl.update(requestId, { isEnabled: false });
}
