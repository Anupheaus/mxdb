import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@anupheaus/common';
import type { NexusAuthRecord } from '@anupheaus/nexus/common';
import type { AuthCollection } from './AuthCollection';
import { deleteDevice, expireStalePendingInvites } from './deviceManagement';

function makeAuthColl(): AuthCollection<NexusAuthRecord> {
  return {
    delete: vi.fn().mockResolvedValue(undefined),
    findStalePendingInvites: vi.fn(),
  } as unknown as AuthCollection<NexusAuthRecord>;
}

describe('deviceManagement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
