import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@anupheaus/common';
import type { NexusAuthRecord } from '@anupheaus/nexus/common';
import type { AuthCollection } from './AuthCollection';
import { deleteDevice, disableDevice, enableDevice, expireStalePendingInvites } from './deviceManagement';

function makeAuthColl(isEnabled = false): AuthCollection<NexusAuthRecord> {
  return {
    delete: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    findById: vi.fn().mockResolvedValue({ requestId: 'req-1', isEnabled }),
    findStalePendingInvites: vi.fn(),
  } as unknown as AuthCollection<NexusAuthRecord>;
}

describe('deviceManagement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // sc-613: a disabled device keeps its session token (so a connection with it is told the device is disabled), but
  // re-enabling must not bring that token back to life: the device signs in again with its passkey for a new one.
  it('enableDevice re-enables the device and removes its old session token', async () => {
    const authColl = makeAuthColl();
    await enableDevice(authColl, 'req-1');
    // Strict: `sessionToken: undefined` is what removes the field (AuthCollection.update $unsets it).
    expect(vi.mocked(authColl.update).mock.calls).toStrictEqual([['req-1', { isEnabled: true, sessionToken: undefined }]]);
  });

  // Enabling a device that is already enabled changes nothing: its current session stays valid.
  it('enableDevice leaves an already-enabled device, and its session, alone', async () => {
    const authColl = makeAuthColl(true);
    await enableDevice(authColl, 'req-1');
    expect(authColl.update).not.toHaveBeenCalled();
  });

  it('disableDevice disables the device, keeping its token so its connections are told why', async () => {
    const authColl = makeAuthColl();
    await disableDevice(authColl, 'req-1');
    expect(authColl.update).toHaveBeenCalledWith('req-1', { isEnabled: false });
  });

  it('deleteDevice removes the auth record by requestId', async () => {
    const authColl = makeAuthColl();
    await deleteDevice(authColl, 'req-99');
    expect(authColl.delete).toHaveBeenCalledWith('req-99');
  });

  it('expireStalePendingInvites deletes each stale invite and returns the count', async () => {
    const authColl = makeAuthColl();
    const stale: NexusAuthRecord[] = [
      { requestId: 'invite-1', sessionToken: 't1', userId: 'u1', deviceId: 'd1', isEnabled: false },
      { requestId: 'invite-2', sessionToken: 't2', userId: 'u1', deviceId: 'd2', isEnabled: false },
    ];
    vi.mocked(authColl.findStalePendingInvites).mockResolvedValue(stale);

    const removed = await expireStalePendingInvites(authColl, 86_400_000);

    expect(removed).toBe(2);
    expect(authColl.findStalePendingInvites).toHaveBeenCalledOnce();
    expect(authColl.delete).toHaveBeenCalledTimes(2);
    expect(authColl.delete).toHaveBeenCalledWith('invite-1');
    expect(authColl.delete).toHaveBeenCalledWith('invite-2');
  });

  it('expireStalePendingInvites returns zero when nothing is stale', async () => {
    const authColl = makeAuthColl();
    vi.mocked(authColl.findStalePendingInvites).mockResolvedValue([]);

    const removed = await expireStalePendingInvites(authColl, 60_000);

    expect(removed).toBe(0);
    expect(authColl.delete).not.toHaveBeenCalled();
  });
});
