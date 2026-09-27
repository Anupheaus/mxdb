export * from './startServer';
export * from './collections';
export * from './hooks';
// whenAllServerDbsConfigured is for a caller tearing databases down from outside mxdb - see its
// doc comment. Named on this line rather than imported straight from './providers/db/ServerDb':
// a second import path for the same module changes this barrel's initialisation order, which the
// auth-collection suites are sensitive to (their hooks then time out).
export { provideDb, ServerDb, useDb, withDb, withConnectionDb, runInDbScope, whenAllServerDbsConfigured } from './providers';
export type { DbCollectionSyncProps, UpsertProps, DeleteProps } from './providers/db/ServerDbCollection';
export type { MXDBAccount, MXDBDeviceInfo } from '../common/models';
// The types in `startServer`'s own signature. `startServer` is public but these were not,
// so a consumer could pass a config literal yet never name its type - and anyone
// implementing `ServerConfig.resolveConnectionDb` could not name either side of it.
export type { ServerConfig, ServerInstance, ConnectionDbTarget, ConnectionHandshake } from './internalModels';
export { useAuthentication } from '@anupheaus/nexus/server';
export { useAuthDevices } from './auth/useAuthDevices';
export type { AuthDevicesApi } from './auth/useAuthDevices';
export type { SSLConfig, TLSCertificate } from '@anupheaus/nexus/server';