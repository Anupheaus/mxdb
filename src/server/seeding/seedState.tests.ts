import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { loadSeedState, SEED_STATE_COLLECTION_NAME } from './seedState';

/**
 * Which fixed records each collection last applied is kept in the seeded database itself, so a server whose working
 * directory is replaced on every deploy (a container) does not re-apply unchanged seeds on every start, and every
 * database (one per tenant) keeps its own record.
 */

let mongod: MongoMemoryServer;
let client: MongoClient;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
});

afterAll(async () => {
  await client?.close();
  await mongod?.stop();
});

describe('seed state', () => {
  it('is empty for a database never seeded', async () => {
    const state = await loadSeedState(client.db('never-seeded'));
    expect([...state.hashes]).toEqual([]);
  });

  it('survives a restart: a hash saved by one start is read by the next', async () => {
    const db = client.db('restarted');
    await (await loadSeedState(db)).save('payment-types', 'hash-1');

    const afterRestart = await loadSeedState(db);

    expect([...afterRestart.hashes]).toEqual([['payment-types', 'hash-1']]);
  });

  it('keeps one entry per collection, replaced when its fixed records change', async () => {
    const db = client.db('changed');
    const state = await loadSeedState(db);
    await state.save('products', 'hash-1');
    await state.save('products', 'hash-2');

    const docs = await db.collection(SEED_STATE_COLLECTION_NAME).find({}, { projection: { appliedAt: 0 } }).toArray();

    expect({ docs, inMemory: [...state.hashes] }).toEqual({ docs: [{ _id: 'products', hash: 'hash-2' }], inMemory: [['products', 'hash-2']] });
  });

  it('is per database: seeding one tenant leaves another unseeded', async () => {
    await (await loadSeedState(client.db('tenant-a'))).save('premises-types', 'hash-a');

    const tenantB = await loadSeedState(client.db('tenant-b'));

    expect([...tenantB.hashes]).toEqual([]);
  });
});
