/**
 * A live query must always deliver a result once the server has answered its subscription, whatever order the
 * subscription answer, the local re-runs and the local reads finish in (Vision sc-5221).
 *
 * A device reload left Vision's sign-in on "Authenticating, please wait..." for ever, about once in eleven runs: the
 * session user-account `useQuery` stayed `isLoading`. The wrapper runs the local query up to three times around a
 * subscribe (the server's answer, the answer replayed to a late subscriber of the same subscription, and the initial
 * run), and only the newest of those runs may deliver. The initial run used to stand down whenever the server answer
 * had not FINISHED by the time it read the collection, so when it was the newest run nothing was delivered at all.
 *
 * These tests script the subscription the way nexus and react-ui deliver it (the answer is handed to the callback
 * without being awaited, before and/or after `subscribe` resolves) and the collection's reads finishing in every order.
 */
// @vitest-environment jsdom

import '@anupheaus/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DataRequest, Record } from '@anupheaus/common';
import { LoggerProvider, useLogger } from '@anupheaus/react-ui';
import type { DbCollection } from '../../providers/dbs/DbCollection';
import type { MXDBCollectionEvent } from '../../providers/dbs/models';
import type { QueryResults } from '../../../common/models';
import type { UseSubscription, UseSubscriptionExecuteProps } from './createUseSubscription';
import { createQuery, type QueryResponse } from './createQuery';

vi.mock('@anupheaus/nexus/client', () => ({
  useNexus: () => ({ getIsConnected: () => true }),
  useAction: () => ({}),
}));

interface Widget extends Record {
  id: string;
  name: string;
}

const STORED: Widget[] = [{ id: 'w1', name: 'Session user account' }];

// ─── A collection whose reads finish when the test says ─────────────────────

interface PendingRead {
  resolve(): void;
}

/** Each read takes its snapshot when it is made (as `DbCollection.query` does) and finishes when the test releases it. */
class ControlledCollection {
  readonly name = 'widgets';
  readonly pendingReads: PendingRead[] = [];
  readonly #records = new Map<string, Widget>();
  readonly #listeners = new Set<(event: MXDBCollectionEvent<Widget>) => void>();

  query(_request: DataRequest<Widget>): Promise<QueryResults<Widget>> {
    const records = [...this.#records.values()];
    return new Promise(resolve => {
      this.pendingReads.push({ resolve: () => resolve({ records, total: records.length }) });
    });
  }

  onChange(callback: (event: MXDBCollectionEvent<Widget>) => void): () => void {
    this.#listeners.add(callback);
    return () => this.#listeners.delete(callback);
  }

  /** The server's pushed records landing in the local collection (S2C sync), before the subscription answers. */
  store(records: Widget[]): void {
    records.forEach(record => this.#records.set(record.id, record));
  }
}

// ─── A subscription scripted the way nexus + react-ui deliver it ────────────

/** When the server's answer reaches this subscriber's callback, relative to `subscribe` resolving. */
type AnswerTiming =
  /** a new subscription: the answer arrives inside `subscribe`, then react-ui replays it (callWithLastPayload) */
  | 'answer-and-replay-before-resolve'
  /** the answer arrives inside `subscribe`, once */
  | 'answer-before-resolve'
  /** `subscribe` resolves first (offline at subscribe, or a second subscriber waiting on the first one's answer) */
  | 'answer-after-resolve';

const ANSWER_TIMINGS: AnswerTiming[] = ['answer-and-replay-before-resolve', 'answer-before-resolve', 'answer-after-resolve'];

interface ScriptedSubscription {
  useSubscription: UseSubscription;
  /** Sends the answer now (for 'answer-after-resolve'). */
  answerNow(): void;
}

function scriptSubscription(timing: AnswerTiming, total: number): ScriptedSubscription {
  let onUpdateRef: ((response: number) => void) | undefined;
  // react-ui's subscriber handler calls the callback and does not await it, so its async work runs on alone.
  const deliver = () => { void onUpdateRef?.(total); };
  const execute = async ({ disable, onUpdate, onEmptyUpdate }: UseSubscriptionExecuteProps<unknown, number>): Promise<boolean> => {
    onUpdateRef = onUpdate as (response: number) => void;
    if (disable) {
      onUpdate(onEmptyUpdate());
      return false;
    }
    await Promise.resolve(); // the round trip to the server
    if (timing !== 'answer-after-resolve') deliver();
    if (timing === 'answer-and-replay-before-resolve') deliver();
    return true;
  };
  const useSubscription = (() => ({ execute, unsubscribe: () => void 0, subscribe: async () => void 0, onCallback: () => void 0 })) as unknown as UseSubscription;
  return { useSubscription, answerNow: deliver };
}

// ─── Harness ────────────────────────────────────────────────────────────────

interface ProbeProps {
  collection: ControlledCollection;
  useSubscription: UseSubscription;
  delivered: QueryResponse<Widget>[];
}

function QueryProbe({ collection, useSubscription, delivered }: ProbeProps) {
  const logger = useLogger(collection.name);
  const query = createQuery(collection as unknown as DbCollection<Widget>, useSubscription, logger);
  useLayoutEffect(() => {
    void query({}, { onResponse: response => delivered.push(response), onSameResponse: () => void 0 });
  }, []);
  return null;
}

/** Lets every queued microtask (and the awaits they chain) run. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 50; index += 1) await Promise.resolve();
  });
}

/** Every order of `count` items, as index lists. */
function permutationsOf(count: number): number[][] {
  if (count <= 1) return [Array.from({ length: count }, (_, index) => index)];
  return permutationsOf(count - 1).flatMap(rest => Array.from({ length: count }, (_, position) => [...rest.slice(0, position), count - 1, ...rest.slice(position)]));
}

/** How the reads in flight are released: one at a time in an order, or all in the same tick (oldest first). */
type ReadRelease = number[] | 'same-tick';

/**
 * Releases the reads in flight (one at a time in `release` order, settling between each, or all in the same tick), then
 * keeps releasing any read made after that, oldest first, until none is left.
 */
async function releaseReads(collection: ControlledCollection, release: ReadRelease): Promise<void> {
  const { pendingReads } = collection;
  const inFlight = pendingReads.splice(0, pendingReads.length);
  if (release === 'same-tick') {
    inFlight.forEach(read => read.resolve());
  } else {
    for (const readIndex of release) {
      inFlight[readIndex]!.resolve();
      await settle();
    }
    inFlight.forEach(read => read.resolve()); // any not named in the order (resolving twice is a no-op)
  }
  await settle();
  while (pendingReads.length > 0) {
    pendingReads.shift()!.resolve();
    await settle();
  }
}

describe('useSubscriptionWrapper delivers a live query result whatever order things finish in (sc-5221)', () => {
  let root: Root | undefined;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
  });

  async function mount(props: ProbeProps): Promise<void> {
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(
      <LoggerProvider logger={undefined} loggerName="sc-5221">
        <QueryProbe {...props} />
      </LoggerProvider>,
    ));
    await settle();
  }

  // Expected outcome, written independently of the implementation: once the server has answered and every read has
  // finished, the stored record has been delivered, and the last thing delivered is the stored record.
  const expectStoredRecordDelivered = (delivered: QueryResponse<Widget>[]) => {
    expect(delivered.length).toBeGreaterThan(0);
    expect(delivered.at(-1)!.records.map(({ id }) => id)).toEqual(['w1']);
  };

  for (const timing of ANSWER_TIMINGS) {
    // Up to three reads are in flight (answer, replay, initial run); every order they can finish in.
    const readCount = timing === 'answer-and-replay-before-resolve' ? 3 : timing === 'answer-before-resolve' ? 2 : 1;
    const releases: ReadRelease[] = ['same-tick', ...permutationsOf(readCount)];
    for (const release of releases) {
      it(`${timing}, reads finishing ${release === 'same-tick' ? 'in the same tick' : `in order ${release.join(',')}`}`, async () => {
        const collection = new ControlledCollection();
        collection.store(STORED);
        const subscription = scriptSubscription(timing, STORED.length);
        const delivered: QueryResponse<Widget>[] = [];

        await mount({ collection, useSubscription: subscription.useSubscription, delivered });
        expect(collection.pendingReads.length).toBe(readCount);
        await releaseReads(collection, release);

        if (timing === 'answer-after-resolve') {
          // Waiting for the server: the local read alone must not be delivered as if it were the answer.
          expect(delivered).toEqual([]);
          await act(async () => subscription.answerNow());
          await settle();
          await releaseReads(collection, []);
        }

        expectStoredRecordDelivered(delivered);
      });
    }
  }
});
