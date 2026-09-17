import type { CreateInviteOptions } from '@anupheaus/nexus/server';
import type { WebAuthnAuthRecord } from '@anupheaus/nexus/common';
import type { MXDBDeviceInfo } from '../../common/models';

export interface AuthDevicesApi {
  listForUser(userId: string): Promise<MXDBDeviceInfo[]>;
  createInvite(options: CreateInviteOptions): Promise<string>;
  setEnabled(requestId: string, isEnabled: boolean): Promise<void>;
  deleteDevice(requestId: string): Promise<void>;
  /** Deletes pending invites older than `ttlMs`. Returns the number removed. */
  expireStalePendingInvites(ttlMs: number): Promise<number>;
  findById(requestId: string): Promise<WebAuthnAuthRecord | undefined>;
  create(record: WebAuthnAuthRecord): Promise<void>;
  update(requestId: string, patch: Partial<WebAuthnAuthRecord>): Promise<void>;
}

let authDevicesApi: AuthDevicesApi | undefined;

export function setAuthDevices(api: AuthDevicesApi): void {
  authDevicesApi = api;
}

export function useAuthDevices(): AuthDevicesApi {
  if (authDevicesApi == null) throw new Error('Auth devices have not been initialised.');
  return authDevicesApi;
}
