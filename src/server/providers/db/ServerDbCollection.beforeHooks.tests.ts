import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Logger, Record } from '@anupheaus/common';
import { defineCollection } from '../../../common/defineCollection';
import { auditor } from '../../../common/auditor';
import { extendCollection, type OnClearPayload, type OnDeletePayload, type OnUpsertPayload } from '../../collections/extendCollection';
import { ServerDbCollection } from './ServerDbCollection';

/**
 * Server-side writes (`upsert` / `remove` / `clear` — what the server `useCollection` and record hooks
 * expose) must run the collection's before-write hooks: before anything is persisted, once per write, able
 * to amend upserted records and to read records that are about to be deleted.
 */

vi.mock('@anupheaus/nexus/server', async importOriginal => {
  const actual = await importOriginal() as object;
  return { ...actual, useAuthentication: () => ({ user: undefined }) };
});

interface Place extends Record {
  name: string;
  /** Derived from `name`; a before-upsert hook recomputes it when `name` changes. */
  derived?: string;
}

const hookedCollection = defineCollection<Place>({ name: 'before_hooks_places', indexes: [] });
const AUDIT_COLLECTION_NAME = `${hookedCollection.name}_sync`;

/** Audit writes on upsert are fire-and-forget, so poll (condition-based, no fixed sleep) until they land. */
const AUDIT_WAIT = { timeout: 10_000, interval: 20 };

// The registry cannot be cleared, so the collection's hooks delegate to per-test implementations.
const hooks = {
  onBeforeUpsert: vi.fn<(payload: OnUpsertPayload<Place>) => Promise<void>>(),
  onBeforeDelete: vi.fn<(payload: OnDeletePayload) => Promise<void>>(),
  onBeforeClear: vi.fn<(payload: OnClearPayload) => Promise<void>>(),
  onAfterClear: vi.fn<(payload: OnClearPayload) => Promise<void>>(),
};
extendCollection(hookedCollection, {
  onBeforeUpsert: payload => hooks.onBeforeUpsert(payload),
  onBeforeDelete: payload => hooks.onBeforeDelete(payload),
  onBeforeClear: payload => hooks.onBeforeClear(payload),
  onAfterClear: payload => hooks.onAfterClear(payload),
});

const logger = {
  warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), silly: vi.fn(), createSubLogger: vi.fn().mockReturnThis(),
} as unknown as Logger;

let mongod: MongoMemoryReplSet;
let client: MongoClient;
let places: ServerDbCollection<Place>;

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  client = new MongoClient(mongod.getUri());
  await client.connect();
  // Create the namespaces up front so the collection's background configuration never races to create them.
  const db = client.db('beforehooksdb');
  await db.createCollection(hookedCollection.name);
  await db.createCollection(AUDIT_COLLECTION_NAME);
  // One instance for the whole file: its background configuration then finishes long before teardown.
  places = new ServerDbCollection<Place>({
    getDb: () => Promise.resolve(db),
    collection: hookedCollection,
    collectionNames: Promise.resolve(new Set([hookedCollection.name, AUDIT_COLLECTION_NAME])),
    logger,
  });
}, 90_000);

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

beforeEach(async () => {
  const db = client.db('beforehooksdb');
  await db.collection(hookedCollection.name).deleteMany({});
  await db.collection(AUDIT_COLLECTION_NAME).deleteMany({});
  hooks.onBeforeUpsert.mockReset().mockResolvedValue(undefined);
  hooks.onBeforeDelete.mockReset().mockResolvedValue(undefined);
  hooks.onBeforeClear.mockReset().mockResolvedValue(undefined);
  hooks.onAfterClear.mockReset().mockResolvedValue(undefined);
});

/** Seeds a stored record without the hook seeing it, so each test's act is the only hooked write. */
async function seed(place: Place): Promise<void> {
  await places.upsert(place);
  hooks.onBeforeUpsert.mockClear();
}

/** A before-upsert hook in the shape consumers write: amend the changing records in place. */
function recomputeDerivedWhenNameChanges(): void {
  hooks.onBeforeUpsert.mockImplementation(async ({ records }) => {
    const stored = await places.get(records.ids());
    for (const record of records) {
      if (stored.findById(record.id)?.name !== record.name) record.derived = `from ${record.name}`;
    }
  });
}

describe('ServerDbCollection before-write hooks — upsert', () => {
  it('runs onBeforeUpsert before the record is persisted', async () => {
    await seed({ id: 'p1', name: 'Derby', derived: 'DE1' });
    let storedWhileHookRan: Place | undefined;
    hooks.onBeforeUpsert.mockImplementation(async () => { storedWhileHookRan = await places.get('p1'); });

    await places.upsert({ id: 'p1', name: 'Nottingham', derived: 'DE1' });

    expect(storedWhileHookRan).toEqual({ id: 'p1', name: 'Derby', derived: 'DE1' });
  });

  it('tells the hook which records are inserts and which are updates', async () => {
    await seed({ id: 'existing', name: 'Derby' });

    await places.upsert([{ id: 'existing', name: 'Nottingham' }, { id: 'new', name: 'Leicester' }]);

    expect(hooks.onBeforeUpsert).toHaveBeenCalledWith({
      records: [{ id: 'existing', name: 'Nottingham' }, { id: 'new', name: 'Leicester' }],
      insertedIds: ['new'],
      updatedIds: ['existing'],
    });
  });

  it('persists the amendments the hook makes to the records', async () => {
    await seed({ id: 'p1', name: 'Derby', derived: 'DE1' });
    recomputeDerivedWhenNameChanges();

    await places.upsert({ id: 'p1', name: 'Nottingham', derived: 'DE1' });

    expect(await places.get('p1')).toEqual({ id: 'p1', name: 'Nottingham', derived: 'from Nottingham' });
  });

  it('records the hook\'s amendments in the audit, so the audit replays to the stored record', async () => {
    await seed({ id: 'p1', name: 'Derby', derived: 'DE1' });
    recomputeDerivedWhenNameChanges();

    await places.upsert({ id: 'p1', name: 'Nottingham', derived: 'DE1' });

    await vi.waitFor(async () => {
      expect(auditor.createRecordFrom((await places.getAudit('p1'))!)).toEqual({ id: 'p1', name: 'Nottingham', derived: 'from Nottingham' });
    }, AUDIT_WAIT);
  });

  it('does not change the caller\'s record objects when the hook amends them', async () => {
    await seed({ id: 'p1', name: 'Derby', derived: 'DE1' });
    recomputeDerivedWhenNameChanges();
    const callersRecord: Place = { id: 'p1', name: 'Nottingham', derived: 'DE1' };

    await places.upsert(callersRecord);

    expect(callersRecord).toEqual({ id: 'p1', name: 'Nottingham', derived: 'DE1' });
  });

  it('runs the hook once per write', async () => {
    await places.upsert([{ id: 'p1', name: 'Derby' }, { id: 'p2', name: 'Leicester' }]);

    expect(hooks.onBeforeUpsert).toHaveBeenCalledTimes(1);
  });

  const unchangedWrites: Array<[string, (stored: Place) => Place[]]> = [
    ['the record is rewritten unchanged', stored => [{ ...stored }]],
    ['nothing is written', () => []],
  ];

  it.each(unchangedWrites)('does not run the hook when %s', async (_label, recordsFor) => {
    const stored: Place = { id: 'p1', name: 'Derby' };
    await seed(stored);

    await places.upsert(recordsFor(stored));

    expect(hooks.onBeforeUpsert).not.toHaveBeenCalled();
  });

  it('only hands the hook the records that are changing', async () => {
    await seed({ id: 'same', name: 'Derby' });

    await places.upsert([{ id: 'same', name: 'Derby' }, { id: 'changed', name: 'Leicester' }]);

    expect(hooks.onBeforeUpsert.mock.calls[0]![0].records.ids()).toEqual(['changed']);
  });

  it('rejects the write, persisting nothing, when the hook throws', async () => {
    await seed({ id: 'p1', name: 'Derby' });
    hooks.onBeforeUpsert.mockRejectedValue(new Error('name is not allowed'));

    await expect(places.upsert([{ id: 'p1', name: 'Nottingham' }, { id: 'p2', name: 'Leicester' }])).rejects.toThrow('name is not allowed');
    expect(await places.getAll()).toEqual([{ id: 'p1', name: 'Derby' }]);
  });
});

describe('ServerDbCollection before-write hooks — remove', () => {
  it('runs onBeforeDelete while the record is still stored', async () => {
    await seed({ id: 'p1', name: 'Derby' });
    let storedWhileHookRan: Place | undefined;
    hooks.onBeforeDelete.mockImplementation(async () => { storedWhileHookRan = await places.get('p1'); });

    await places.remove('p1');

    expect(storedWhileHookRan).toEqual({ id: 'p1', name: 'Derby' });
  });

  it('hands the hook only the ids that are stored', async () => {
    await seed({ id: 'p1', name: 'Derby' });
    await seed({ id: 'p2', name: 'Leicester' });

    await places.remove(['p1', 'missing', 'p2']);

    expect(hooks.onBeforeDelete.mock.calls).toEqual([[{ recordIds: ['p1', 'p2'] }]]);
  });

  it('does not run the hook when none of the records exist', async () => {
    await places.remove(['missing']);

    expect(hooks.onBeforeDelete).not.toHaveBeenCalled();
  });

  it('rejects the delete, removing nothing, when the hook throws', async () => {
    await seed({ id: 'p1', name: 'Derby' });
    hooks.onBeforeDelete.mockRejectedValue(new Error('still referenced'));

    await expect(places.remove('p1')).rejects.toThrow('still referenced');
    expect(await places.get('p1')).toEqual({ id: 'p1', name: 'Derby' });
  });
});

describe('ServerDbCollection before-write hooks — clear', () => {
  it('runs onBeforeClear while the records are still stored', async () => {
    await seed({ id: 'p1', name: 'Derby' });
    let countWhileHookRan: number | undefined;
    hooks.onBeforeClear.mockImplementation(async () => { countWhileHookRan = await places.count(); });

    await places.clear();

    expect(countWhileHookRan).toBe(1);
  });

  it('runs onAfterClear once the records are gone', async () => {
    await seed({ id: 'p1', name: 'Derby' });
    let countWhenHookRan: number | undefined;
    hooks.onAfterClear.mockImplementation(async () => { countWhenHookRan = await places.count(); });

    await places.clear();

    expect([countWhenHookRan, hooks.onAfterClear.mock.calls]).toEqual([0, [[{ collectionName: hookedCollection.name }]]]);
  });

  it('keeps the records when onBeforeClear throws', async () => {
    await seed({ id: 'p1', name: 'Derby' });
    hooks.onBeforeClear.mockRejectedValue(new Error('not now'));

    await expect(places.clear()).rejects.toThrow('not now');
    expect(await places.count()).toBe(1);
  });
});
