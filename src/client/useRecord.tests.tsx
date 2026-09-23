// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@anupheaus/common';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Record as MXDBRecord } from '@anupheaus/common';
import type { MXDBCollection } from '../common';
import { ConflictResolutionContext } from './providers/conflictResolution/ConflictResolutionContext';

// ─── Controllable local store (the useCollection boundary) ────────────────────

interface Person extends MXDBRecord {
  name: string;
  city: string;
}

interface StoreState {
  record?: Person;
  isLoading: boolean;
  error?: Error;
}

const { store } = vi.hoisted(() => ({
  store: {
    state: { isLoading: false } as StoreState,
    requestedIds: [] as (string | undefined)[],
    upsert: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('./hooks/useCollection/useCollection', () => ({
  useCollection: () => ({
    useGet: (id: string | undefined) => { store.requestedIds.push(id); return store.state; },
    upsert: store.upsert,
    remove: store.remove,
  }),
}));

const { useRecord } = await import('./useRecord');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─── Harness ──────────────────────────────────────────────────────────────────

const PEOPLE = { name: 'people' } as MXDBCollection<Person>;

const person = (overrides: Partial<Person> = {}): Person => ({ id: 'p1', name: 'Ann', city: 'Leeds', ...overrides });

const observed = { result: undefined as ReturnType<typeof useRecord<MXDBCollection<Person>>> | undefined };

function Probe({ recordOrId }: { recordOrId: Person | string | undefined }): null {
  observed.result = useRecord(recordOrId, PEOPLE);
  return null;
}

let root: Root;

type ConflictHandler = (message: string) => Promise<boolean>;

function render(recordOrId: Person | string | undefined, onConflictResolution?: ConflictHandler): void {
  act(() => {
    root.render(
      <ConflictResolutionContext.Provider value={{ onConflictResolution }}>
        <Probe recordOrId={recordOrId} />
      </ConflictResolutionContext.Provider>,
    );
  });
}

/** Simulates the local store emitting a new state for the record (e.g. an S2C push), then re-renders. */
function storeChanges(state: StoreState, recordOrId: Person | string | undefined, onConflictResolution?: ConflictHandler): void {
  store.state = state;
  render(recordOrId, onConflictResolution);
}

beforeEach(() => {
  store.state = { isLoading: false };
  store.requestedIds = [];
  store.upsert.mockReset();
  store.remove.mockReset();
  observed.result = undefined;
  root = createRoot(document.createElement('div'));
});

afterEach(() => {
  act(() => root.unmount());
});

// ─── Viewing by id ────────────────────────────────────────────────────────────

describe('useRecord given an id', () => {
  it('returns the stored record', () => {
    store.state = { record: person(), isLoading: false };

    render('p1');

    expect(observed.result?.record).toEqual(person());
  });

  it('reflects later changes to the stored record', () => {
    store.state = { record: person(), isLoading: false };
    render('p1');

    storeChanges({ record: person({ name: 'Bea' }), isLoading: false }, 'p1');

    expect(observed.result?.record).toEqual(person({ name: 'Bea' }));
  });

  it('passes through the loading and error state of the lookup', () => {
    const error = new Error('lookup failed');
    store.state = { isLoading: true, error };

    render('p1');

    expect({ isLoading: observed.result?.isLoading, error: observed.result?.error }).toEqual({ isLoading: true, error });
  });

  it.each([
    ['an id', 'p1', 'p1'],
    ['a record', person({ id: 'p9' }), 'p9'],
    ['nothing', undefined, undefined],
  ] as const)('looks up the record by id when given %s', (_label, recordOrId, expectedId) => {
    render(recordOrId as Person | string | undefined);

    expect(store.requestedIds.at(-1)).toBe(expectedId);
  });

  it('exposes the collection upsert and remove operations', () => {
    render('p1');

    expect({ upsert: observed.result?.upsert, remove: observed.result?.remove }).toEqual({ upsert: store.upsert, remove: store.remove });
  });
});

// ─── Editing a record ─────────────────────────────────────────────────────────

describe('useRecord given a record being edited', () => {
  it('returns the caller\'s working copy rather than the stored record', () => {
    store.state = { record: person(), isLoading: false };

    render(person({ name: 'Edited' }));

    expect(observed.result?.record).toEqual(person({ name: 'Edited' }));
  });

  it('rebases the caller\'s edits onto a newer stored version', () => {
    store.state = { record: person(), isLoading: false };
    const working = person({ name: 'Edited' });
    render(working);

    storeChanges({ record: person({ city: 'York' }), isLoading: false }, working);

    expect(observed.result?.record).toEqual(person({ name: 'Edited', city: 'York' }));
  });

  it('keeps the caller\'s edit when the server changed the same field', () => {
    store.state = { record: person(), isLoading: false };
    const working = person({ name: 'Edited' });
    render(working);

    storeChanges({ record: person({ name: 'Server' }), isLoading: false }, working);

    expect(observed.result?.record?.name).toBe('Edited');
  });

  it('keeps the working copy when the stored record is replaced by an equal value', () => {
    store.state = { record: person(), isLoading: false };
    const working = person({ name: 'Edited' });
    render(working);

    storeChanges({ record: person(), isLoading: false }, working);

    expect(observed.result?.record).toBe(working);
  });

  it('does not rebase when the stored record first arrives', () => {
    const working = person({ name: 'Edited' });
    render(working);

    storeChanges({ record: person({ city: 'York' }), isLoading: false }, working);

    expect(observed.result?.record).toBe(working);
  });

  it('returns to the stored record once editing ends', () => {
    store.state = { record: person(), isLoading: false };
    const working = person({ name: 'Edited' });
    render(working);
    storeChanges({ record: person({ city: 'York' }), isLoading: false }, working);

    render('p1');

    expect(observed.result?.record).toEqual(person({ city: 'York' }));
  });
});

// ─── Deletion while editing ───────────────────────────────────────────────────

describe('useRecord when the record is deleted while being edited', () => {
  async function deleteWhileEditing(onConflictResolution?: ConflictHandler): Promise<Person> {
    store.state = { record: person(), isLoading: false };
    const working = person({ name: 'Edited' });
    render(working, onConflictResolution);
    await act(async () => { storeChanges({ record: undefined, isLoading: false }, working, onConflictResolution); });
    return working;
  }

  it('asks the user whether to restore the record', async () => {
    const onConflictResolution = vi.fn(() => Promise.resolve(false));

    await deleteWhileEditing(onConflictResolution);

    expect(onConflictResolution).toHaveBeenCalledWith('This record has been deleted by another user. Do you want to restore it?');
  });

  it('re-saves the working copy when the user chooses to restore', async () => {
    const working = await deleteWhileEditing(() => Promise.resolve(true));

    expect(store.upsert).toHaveBeenCalledWith(working);
  });

  it('does not re-save when the user declines to restore', async () => {
    await deleteWhileEditing(() => Promise.resolve(false));

    expect(store.upsert).not.toHaveBeenCalled();
  });

  it('does not re-save when no conflict handler is configured', async () => {
    await deleteWhileEditing();

    expect(store.upsert).not.toHaveBeenCalled();
  });

  it('keeps showing the working copy', async () => {
    const working = await deleteWhileEditing(() => Promise.resolve(false));

    expect(observed.result?.record).toBe(working);
  });
});
