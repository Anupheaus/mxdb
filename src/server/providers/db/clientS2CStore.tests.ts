import { describe, it, expect } from 'vitest';
import type { Socket } from 'socket.io';
import type { ServerToClientSynchronisation } from '../../ServerToClientSynchronisation';
import { lookupClientS2C, registerClientS2C, unregisterClientS2C } from './clientS2CStore';

// The store is a module-level WeakMap — it persists for the lifetime of the module
// instance. Each test creates its own socket object so no test can read another
// test's entry from the map.
const makeSocket = () => ({}) as unknown as Socket;
const makeS2C = () => ({}) as unknown as ServerToClientSynchronisation;

describe('clientS2CStore', () => {
  it('register then lookup returns the registered s2c', () => {
    const socket = makeSocket();
    const s2c = makeS2C();

    registerClientS2C(socket, s2c);

    expect(lookupClientS2C(socket)).toBe(s2c);
  });

  it('lookup of a socket that was never registered returns undefined', () => {
    const socket = makeSocket();

    expect(lookupClientS2C(socket)).toBeUndefined();
  });

  it('lookup after unregister returns undefined', () => {
    const socket = makeSocket();
    const s2c = makeS2C();

    registerClientS2C(socket, s2c);
    unregisterClientS2C(socket);

    expect(lookupClientS2C(socket)).toBeUndefined();
  });

  it('different sockets are stored independently', () => {
    const socketA = makeSocket();
    const socketB = makeSocket();
    const s2cA = makeS2C();
    const s2cB = makeS2C();

    registerClientS2C(socketA, s2cA);
    registerClientS2C(socketB, s2cB);

    expect(lookupClientS2C(socketA)).toBe(s2cA);
    expect(lookupClientS2C(socketB)).toBe(s2cB);
  });
});
