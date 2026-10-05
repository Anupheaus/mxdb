import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@anupheaus/common';
import type { NexusAuthRecord } from '@anupheaus/nexus/common';
import type { AuthCollection } from './AuthCollection';
import { deleteDevice, deletePendingInvite, disableDevice, enableDevice, expireStalePendingInvites } from './deviceManagement';

function makeAuthColl(isEnabled = false): AuthCollection<NexusAuthRecord> {
  return {
    delete: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    findById: vi.fn().mockResolvedValue({ requestId: 'req-1', isEnabled }),
    enableIfDisabled: vi.fn().mockResolvedValue(!isEnabled),
    deleteStalePendingInvites: vi.fn(),
    deletePendingInvite: vi.fn(),
  } as unknown as AuthCollection<NexusAuthRecord>;
}

describe('deviceManagement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // sc-613: a disabled device keeps its session token (so a connection with it is told the device is disabled), but
  // re-enabling must not bring that token back to life: the device signs in again with its passkey for a new one.
  // One conditional write (AuthCollection.enableIfDisabled, tested against MongoDB): enable, and remove the old session,
  // only if the device is disabled, so an enabled device keeps its session and racing enables cannot clear a new one.
  it('enableDevice enables through one conditional write, with no plain update', async () => {
    const authColl = makeAuthColl();
    await enableDevice(authColl, 'req-1');
    expect({ enabled: vi.mocked(authColl.enableIfDisabled).mock.calls, updated: vi.mocked(authColl.update).mock.calls.length }).toEqual({ enabled: [['req-1']], updated: 0 });
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

  // The sweep and the conditional delete are each ONE write whose filter re-checks that the record is still a pending
  // invite (tested against MongoDB in AuthCollection.pendingInvite.tests.ts), so neither lists records and deletes them after.
  it('expireStalePendingInvites deletes invites created before the cut-off in one write and returns the count', async () => {
    const authColl = makeAuthColl();
    vi.mocked(authColl.deleteStalePendingInvites).mockResolvedValue(2);
    vi.spyOn(Date, 'now').mockReturnValue(100_000_000);

    const removed = await expireStalePendingInvites(authColl, 86_400_000);

    expect({ removed, cutOffs: vi.mocked(authColl.deleteStalePendingInvites).mock.calls, deleted: vi.mocked(authColl.delete).mock.calls.length })
      .toEqual({ removed: 2, cutOffs: [[13_600_000]], deleted: 0 });
  });

  it('deletePendingInvite deletes through the conditional write and reports whether it did', async () => {
    const authColl = makeAuthColl();
    vi.mocked(authColl.deletePendingInvite).mockResolvedValue(false);

    expect(await deletePendingInvite(authColl, 'req-1')).toBe(false);
    expect({ conditional: vi.mocked(authColl.deletePendingInvite).mock.calls, plain: vi.mocked(authColl.delete).mock.calls.length }).toEqual({ conditional: [['req-1']], plain: 0 });
  });
});
