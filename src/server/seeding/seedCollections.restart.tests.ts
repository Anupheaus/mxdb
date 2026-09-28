import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Logger, Record } from '@anupheaus/common';
import { defineCollection } from '../../common/defineCollection';
import { extendCollection } from '../collections/extendCollection';
import { useCollection } from '../collections';
import { provideDb, runInDbScope, type ServerDb } from '../providers/db';
import { seedCollections } from './seedCollections';

/**
 * Seeding against a real database, across "restarts" (a fresh ServerDb, as a new process makes, with nothing carried
 * over in memory or in the working directory): an unchanged seed is not re-applied, so a seeded record edited in the
 * app keeps its edit; and each database keeps its own seed state (Vision sc-470).
 */

// No ambient Logger scope in tests (and common's resolves through `window`, which the vitest setup defines).
const { logger } = vi.hoisted(() => {
  const fake = { warn: () => void 0, error: () => void 0, info: () => void 0, debug: () => void 0, silly: () => void 0, createSubLogger: () => fake };
  return { logger: fake as unknown as Logger };
});
vi.mock('@anupheaus/nexus/server', async importOriginal => {
  const actual = await importOriginal() as object;
  return { ...actual, useAuthentication: () => ({ user: undefined }), useLogger: () => logger };
});
vi.mock('@anupheaus/common', async importOriginal => {
  const actual = await importOriginal() as object;
  return { ...actual, useLogger: () => logger };
});

interface PaymentType extends Record {
  name: string;
}

const paymentTypes = defineCollection<PaymentType>({ name: 'restart_payment_types', indexes: [] });
let fixedRecords: PaymentType[] = [{ id: 'card', name: 'Card' }, { id: 'cash', name: 'Cash' }];
extendCollection(paymentTypes, { onSeed: async seedWith => { await seedWith({ fixedRecords }); } });

let mongod: MongoMemoryReplSet;
const openDbs: ServerDb[] = [];

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
}, 90_000);

afterAll(async () => {
  await Promise.all(openDbs.map(db => db.close()));
  await mongod?.stop();
});

/** One server process's lifetime against `dbName`: a fresh ServerDb, then `delegate` inside it. */
function inProcess<R>(dbName: string, delegate: () => Promise<R>): Promise<R> {
  return runInDbScope(() => provideDb(dbName, mongod.getUri(), [paymentTypes], db => {
    openDbs.push(db);
    return delegate();
  }, { watch: false }));
}

const start = (dbName: string) => inProcess(dbName, () => seedCollections([paymentTypes]));
const read = (dbName: string) => inProcess(dbName, async () => (await useCollection(paymentTypes).getAll()).map(({ id, name }) => ({ id, name })).orderBy(({ id }) => id));

describe('seeding across restarts', () => {
  it('keeps a seeded record edited in the app when the server restarts with unchanged seeds', async () => {
    await start('restart-edit');
    await inProcess('restart-edit', () => useCollection(paymentTypes).upsert({ id: 'card', name: 'Card (edited)' }));

    await start('restart-edit');

    expect(await read('restart-edit')).toEqual([{ id: 'card', name: 'Card (edited)' }, { id: 'cash', name: 'Cash' }]);
  });

  it('applies a changed seed on the next restart', async () => {
    await start('restart-changed');
    fixedRecords = [{ id: 'card', name: 'Card' }, { id: 'cash', name: 'Cash' }, { id: 'bank', name: 'Bank transfer' }];
    try {
      await start('restart-changed');
    } finally {
      fixedRecords = [{ id: 'card', name: 'Card' }, { id: 'cash', name: 'Cash' }];
    }

    expect(await read('restart-changed')).toEqual([{ id: 'bank', name: 'Bank transfer' }, { id: 'card', name: 'Card' }, { id: 'cash', name: 'Cash' }]);
  });

  it('seeds every database: seeding one leaves the next still to seed', async () => {
    await start('tenant-one');
    await start('tenant-two');

    expect({ one: await read('tenant-one'), two: await read('tenant-two') })
      .toEqual({ one: [{ id: 'card', name: 'Card' }, { id: 'cash', name: 'Cash' }], two: [{ id: 'card', name: 'Card' }, { id: 'cash', name: 'Cash' }] });
  });
});
