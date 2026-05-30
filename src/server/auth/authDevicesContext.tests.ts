import { describe, it, expect, beforeEach } from 'vitest';
import { setAuthDevices, useAuthDevices } from './authDevicesContext';
import type { AuthDevicesApi } from './authDevicesContext';

describe('authDevicesContext', () => {
  beforeEach(() => {
    setAuthDevices(undefined as unknown as AuthDevicesApi);
  });

  it('throws when useAuthDevices is called before setAuthDevices', () => {
    expect(() => useAuthDevices()).toThrow(/not been initialised/i);
  });

  it('returns the API registered by setAuthDevices', async () => {
    const api: AuthDevicesApi = {
      listForUser: async () => [],
      createInvite: async () => 'https://invite',
      setEnabled: async () => undefined,
      deleteDevice: async () => undefined,
      expireStalePendingInvites: async () => 0,
    };
    setAuthDevices(api);
    expect(useAuthDevices()).toBe(api);
  });
});
