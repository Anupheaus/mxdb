import { describe, it, expect, beforeEach } from 'vitest';
import {
  upsertConnectedClient,
  removeConnectedClient,
  listConnectedClients,
  __resetConnectedClientsForTests,
} from './connectedClients';

beforeEach(() => {
  __resetConnectedClientsForTests();
});

// ─── upsertConnectedClient ────────────────────────────────────────────────────

describe('upsertConnectedClient', () => {
  it('adds a new client', () => {
    upsertConnectedClient({ socketId: 'sock-1', userId: 'user-1' });
    const clients = listConnectedClients();
    expect(clients).toHaveLength(1);
    expect(clients[0]).toEqual({ socketId: 'sock-1', userId: 'user-1', accountId: undefined });
  });

  it('overwrites an existing entry with the same socketId', () => {
    upsertConnectedClient({ socketId: 'sock-1', userId: 'user-1' });
    upsertConnectedClient({ socketId: 'sock-1', userId: 'user-2', accountId: 'acc-99' });
    const clients = listConnectedClients();
    expect(clients).toHaveLength(1);
    expect(clients[0]).toEqual({ socketId: 'sock-1', userId: 'user-2', accountId: 'acc-99' });
  });

  it('ignores an empty socketId', () => {
    upsertConnectedClient({ socketId: '' });
    expect(listConnectedClients()).toHaveLength(0);
  });

  it('stores multiple clients independently', () => {
    upsertConnectedClient({ socketId: 'sock-1', userId: 'user-1' });
    upsertConnectedClient({ socketId: 'sock-2', userId: 'user-2' });
    upsertConnectedClient({ socketId: 'sock-3' });
    const clients = listConnectedClients();
    expect(clients).toHaveLength(3);
    const ids = clients.map(c => c.socketId).sort();
    expect(ids).toEqual(['sock-1', 'sock-2', 'sock-3']);
  });
});

// ─── removeConnectedClient ────────────────────────────────────────────────────

describe('removeConnectedClient', () => {
  it('removes a registered client', () => {
    upsertConnectedClient({ socketId: 'sock-1' });
    removeConnectedClient('sock-1');
    expect(listConnectedClients()).toHaveLength(0);
  });

  it('is a no-op for an unregistered socketId', () => {
    upsertConnectedClient({ socketId: 'sock-1' });
    removeConnectedClient('sock-unknown');
    expect(listConnectedClients()).toHaveLength(1);
  });

  it('is a no-op for an empty socketId', () => {
    upsertConnectedClient({ socketId: 'sock-1' });
    removeConnectedClient('');
    expect(listConnectedClients()).toHaveLength(1);
  });

  it('does not affect other clients when removing one', () => {
    upsertConnectedClient({ socketId: 'sock-1', userId: 'user-1' });
    upsertConnectedClient({ socketId: 'sock-2', userId: 'user-2' });
    removeConnectedClient('sock-1');
    const clients = listConnectedClients();
    expect(clients).toHaveLength(1);
    expect(clients[0]!.socketId).toBe('sock-2');
  });
});

// ─── listConnectedClients ─────────────────────────────────────────────────────

describe('listConnectedClients', () => {
  it('returns an empty array when no clients are registered', () => {
    expect(listConnectedClients()).toEqual([]);
  });

  it('returns all registered clients', () => {
    upsertConnectedClient({ socketId: 'sock-1', userId: 'u1', accountId: 'a1' });
    upsertConnectedClient({ socketId: 'sock-2' });
    const clients = listConnectedClients();
    expect(clients).toHaveLength(2);
    expect(clients.map(c => c.socketId).sort()).toEqual(['sock-1', 'sock-2']);
  });

  it('returns a snapshot — mutations to the returned array do not affect the store', () => {
    upsertConnectedClient({ socketId: 'sock-1' });
    const clients = listConnectedClients();
    clients.pop();
    expect(listConnectedClients()).toHaveLength(1);
  });
});
