import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Logger, Record } from '@anupheaus/common';
import { defineCollection } from '../../../common/defineCollection';
import type { MXDBCollection } from '../../../common';
import { extendCollection, type MXDBWriteLock, type OnClearPayload, type OnDeletePayload, type OnUpsertPayload } from '../../collections/extendCollection';
import { ServerDbCollection } from './ServerDbCollection';

/**
 * sc-2402: a collection's `writeLock` is held across a server write's before-write check AND its save, for `upsert`,
 * `remove` and `clear`. Each test pauses the check, then asks for the lock the way a concurrent action would: with the
 * lock, that action only runs once the write is saved; without it (the control), it runs in between.
 */

interface TestItem extends Record {
  name: string;
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>(settle => { resolve = settle; });
  return { promise, resolve };
}

/** A plain FIFO mutex — deliberately NOT re-entrant, so mxdb's own re-entrancy is what the nesting test proves. */
function createMutex(): MXDBWriteLock {
  let tail: Promise<unknown> = Promise.resolve();
  return task => {
    const run = tail.then(task);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}

const writeLock = createMutex();

// The extension registry cannot be cleared, so each collection's hooks delegate to per-test implementations.
const hooks = {
  onBeforeUpsert: vi.fn<(payload: OnUpsertPayload<TestItem>) => Promise<void>>(),
  onBeforeDelete: vi.fn<(payload: OnDeletePayload) => Promise<void>>(),
  onBeforeClear: vi.fn<(payload: OnClearPayload) => Promise<void>>(),
};

const lockedCollection = defineCollection<TestItem>({ name: 'write_lock_items', indexes: [], disableAudit: true });
const sharingCollection = defineCollection<TestItem>({ name: 'write_lock_sharing', indexes: [], disableAudit: true });
const unlockedCollection = defineCollection<TestItem>({ name: 'write_lock_unlocked', indexes: [], disableAudit: true });

for (const collection of [lockedCollection, unlockedCollection]) {
  extendCollection(collection, {
    onBeforeUpsert: async payload => { await hooks.onBeforeUpsert(payload); },
    onBeforeDelete: payload => hooks.onBeforeDelete(payload),
    onBeforeClear: payload => hooks.onBeforeClear(payload),
  });
}
extendCollection(lockedCollection, { writeLock });
extendCollection(sharingCollection, { writeLock });

const mockLogger = {
  warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), silly: vi.fn(), createSubLogger: vi.fn().mockReturnThis(),
} as unknown as Logger;

let mongod: MongoMemoryReplSet;
let client: MongoClient;

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  client = new MongoClient(mongod.getUri());
  await client.connect();
  const db = client.db('writelockdb');
  for (const { name } of [lockedCollection, sharingCollection, unlockedCollection]) await db.createCollection(name);
}, 90_000);

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

function makeCol(collection: MXDBCollection<TestItem>): ServerDbCollection<TestItem> {
  const db = client.db('writelockdb');
  const names = [lockedCollection, sharingCollection, unlockedCollection].map(({ name }) => name);
  return new ServerDbCollection<TestItem>({ getDb: () => Promise.resolve(db), collection, collectionNames: Promise.resolve(new Set(names)), logger: mockLogger });
}

beforeEach(async () => {
  const db = client.db('writelockdb');
  for (const { name } of [lockedCollection, sharingCollection, unlockedCollection]) await db.collection(name).deleteMany({});
  hooks.onBeforeUpsert.mockReset().mockResolvedValue(undefined);
  hooks.onBeforeDelete.mockReset().mockResolvedValue(undefined);
  hooks.onBeforeClear.mockReset().mockResolvedValue(undefined);
});

/** Makes the given hook pause until released, and says when it has started. */
function pauseHook(hook: typeof hooks[keyof typeof hooks]): { isRunning: Promise<void>; release(): void } {
  const running = deferred();
  const released = deferred();
  hook.mockImplementation(async () => {
    running.resolve();
    await released.promise;
  });
  return { isRunning: running.promise, release: released.resolve };
}

describe('ServerDbCollection — a collection with a write lock (sc-2402)', () => {

  describe('upsert', () => {
    it('saves before a write that asked for the lock while the check was running', async () => {
      const col = makeCol(lockedCollection);
      const hook = pauseHook(hooks.onBeforeUpsert);

      const writing = col.upsert({ id: 'r1', name: 'saved' });
      await hook.isRunning;
      const seenByAction = writeLock(() => col.get('r1'));
      hook.release();
      await writing;

      expect(await seenByAction).toEqual({ id: 'r1', name: 'saved' });
    });

    it('is judged after a write that already held the lock, and refused when the rule now fails', async () => {
      const col = makeCol(lockedCollection);
      let isFrozen = false;
      hooks.onBeforeUpsert.mockImplementation(async () => {
        if (isFrozen) throw new Error('frozen');
      });
      const actionHolding = deferred();
      const releaseAction = deferred();
      const action = writeLock(async () => {
        actionHolding.resolve();
        await releaseAction.promise;
        isFrozen = true;
      });
      await actionHolding.promise;

      const writing = col.upsert({ id: 'r1', name: 'late' });
      releaseAction.resolve();
      await action;

      await expect(writing).rejects.toThrow('frozen');
      expect(await col.get('r1')).toBeUndefined();
    });

    it('releases the lock when the check refuses the write', async () => {
      const col = makeCol(lockedCollection);
      hooks.onBeforeUpsert.mockRejectedValue(new Error('refused'));

      await expect(col.upsert({ id: 'r1', name: 'x' })).rejects.toThrow('refused');

      expect(await writeLock(async () => 'free')).toBe('free');
    });

    it('lets a check write to another collection that shares the lock without deadlocking', async () => {
      const col = makeCol(lockedCollection);
      const sharing = makeCol(sharingCollection);
      hooks.onBeforeUpsert.mockImplementation(async ({ records }) => {
        await sharing.upsert(records.map(({ id, name }) => ({ id, name: `copy of ${name}` })));
      });

      await col.upsert({ id: 'r1', name: 'original' });

      expect(await sharing.get('r1')).toEqual({ id: 'r1', name: 'copy of original' });
    });

    it('does not hold the lock for a collection that has none (the control: the action runs in between)', async () => {
      const col = makeCol(unlockedCollection);
      const hook = pauseHook(hooks.onBeforeUpsert);

      const writing = col.upsert({ id: 'r1', name: 'saved' });
      await hook.isRunning;
      const seenByAction = await writeLock(() => col.get('r1'));
      hook.release();
      await writing;

      expect(seenByAction).toBeUndefined();
    });
  });

  describe('remove', () => {
    it('deletes before a write that asked for the lock while the check was running', async () => {
      const col = makeCol(lockedCollection);
      await col.upsert({ id: 'r1', name: 'doomed' });
      const hook = pauseHook(hooks.onBeforeDelete);

      const removing = col.remove('r1');
      await hook.isRunning;
      const seenByAction = writeLock(() => col.get('r1'));
      hook.release();
      await removing;

      expect(await seenByAction).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('clears before a write that asked for the lock while the check was running', async () => {
      const col = makeCol(lockedCollection);
      await col.upsert([{ id: 'r1', name: 'a' }, { id: 'r2', name: 'b' }]);
      const hook = pauseHook(hooks.onBeforeClear);

      const clearing = col.clear();
      await hook.isRunning;
      const seenByAction = writeLock(() => col.count());
      hook.release();
      await clearing;

      expect(await seenByAction).toBe(0);
    });
  });
});
