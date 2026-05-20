import { MongoMemoryServer } from 'mongodb-memory-server';

// Pre-download the MongoDB binary once in the main process so parallel
// forked workers find it already cached and skip the download entirely,
// avoiding UnableToUnlockLockfileError from concurrent download races.
export async function setup() {
  const server = await MongoMemoryServer.create();
  await server.stop({ doCleanup: true });
}
