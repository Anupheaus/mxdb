// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Record as MXDBRecord } from '@anupheaus/common';
import type { MXDBCollectionEvent } from '../dbs/models';
import type { ClientToServerSynchronisation } from './ClientToServerSynchronisation';
import { ClientToServerSyncInstanceContext } from './useClientToServerSyncInstance';

// ─── Fake local database ──────────────────────────────────────────────────────

type Listener = (event: MXDBCollectionEvent<MXDBRecord>) => void;

/** Minimal Db stand-in: each collection exposes an onChange stream the test can emit on. */
class FakeDb {
  readonly listeners = new Map<string, Set<Listener>>();

  use(name: string) {
    return {
      onChange: (listener: Listener) => {
        const set = this.listeners.get(name) ?? new Set<Listener>();
        set.add(listener);
        this.listeners.set(name, set);
        return () => { set.delete(listener); };
      },
    };
  }

  emit(name: string, event: MXDBCollectionEvent<MXDBRecord>): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((total, set) => total + set.size, 0);
  }
}

const { dbState, COLLECTIONS } = vi.hoisted(() => ({
  dbState: { current: undefined as unknown },
  COLLECTIONS: [{ name: 'items' }, { name: 'orders' }],
}));

vi.mock('../dbs', () => ({ useDb: () => ({ db: dbState.current, collections: COLLECTIONS }) }));

vi.mock('@anupheaus/react-ui', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createComponent: (_name: string, component: unknown) => component,
}));

const { ClientToServerProvider } = await import('./ClientToServerProvider');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface FakeSync {
  c2s: ClientToServerSynchronisation;
  enqueued: string[];
}

function makeSync(): FakeSync {
  const enqueued: string[] = [];
  const c2s = { enqueue: (collectionName: string, recordId: string) => { enqueued.push(`${collectionName}:${recordId}`); } } as unknown as ClientToServerSynchronisation;
  return { c2s, enqueued };
}

let root: Root;

function render(db: FakeDb, c2s: ClientToServerSynchronisation | null): void {
  dbState.current = db;
  act(() => {
    root.render(
      <ClientToServerSyncInstanceContext.Provider value={c2s}>
        <ClientToServerProvider />
      </ClientToServerSyncInstanceContext.Provider>,
    );
  });
}

beforeEach(() => {
  root = createRoot(document.createElement('div'));
});

afterEach(() => {
  act(() => root.unmount());
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ClientToServerProvider', () => {
  const enqueuedEvents: [string, MXDBCollectionEvent<MXDBRecord>, string[]][] = [
    ['a local upsert', { type: 'upsert', records: [{ id: 'a' }, { id: 'b' }], auditAction: 'default' }, ['items:a', 'items:b']],
    ['a local delete', { type: 'remove', ids: ['a', 'b'], auditAction: 'markAsDeleted' }, ['items:a', 'items:b']],
  ];

  const ignoredEvents: [string, MXDBCollectionEvent<MXDBRecord>][] = [
    ['a server-driven branched upsert', { type: 'upsert', records: [{ id: 'a' }], auditAction: 'branched' }],
    ['a server-driven reconciliation removal', { type: 'remove', ids: ['a'], auditAction: 'remove' }],
    ['a cache clear', { type: 'clear', ids: ['a'] }],
    ['a cross-tab reload', { type: 'reload', records: [{ id: 'a' }] }],
  ];

  it.each(enqueuedEvents)('queues every record touched by %s for sync', (_label, event, expected) => {
    const db = new FakeDb();
    const { c2s, enqueued } = makeSync();
    render(db, c2s);

    db.emit('items', event);

    expect(enqueued).toEqual(expected);
  });

  it.each(ignoredEvents)('does not queue %s', (_label, event) => {
    const db = new FakeDb();
    const { c2s, enqueued } = makeSync();
    render(db, c2s);

    db.emit('items', event);

    expect(enqueued).toEqual([]);
  });

  it('queues records under the collection they changed in', () => {
    const db = new FakeDb();
    const { c2s, enqueued } = makeSync();
    render(db, c2s);

    db.emit('orders', { type: 'upsert', records: [{ id: 'o1' }], auditAction: 'default' });

    expect(enqueued).toEqual(['orders:o1']);
  });

  it('does not subscribe to changes until a sync instance is available', () => {
    const db = new FakeDb();

    render(db, null);

    expect(db.listenerCount()).toBe(0);
  });

  it('stops listening once unmounted', () => {
    const db = new FakeDb();
    render(db, makeSync().c2s);

    act(() => root.unmount());
    root = createRoot(document.createElement('div'));

    expect(db.listenerCount()).toBe(0);
  });

  it('moves its subscriptions to a replacement database', () => {
    const firstDb = new FakeDb();
    const secondDb = new FakeDb();
    const { c2s, enqueued } = makeSync();
    render(firstDb, c2s);

    render(secondDb, c2s);
    firstDb.emit('items', { type: 'upsert', records: [{ id: 'stale' }], auditAction: 'default' });
    secondDb.emit('items', { type: 'upsert', records: [{ id: 'fresh' }], auditAction: 'default' });

    expect(enqueued).toEqual(['items:fresh']);
  });
});
