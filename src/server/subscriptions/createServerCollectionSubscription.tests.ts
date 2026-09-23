import { describe, it, expect, vi } from 'vitest';
import type { NexusSubscription } from '@anupheaus/nexus/common';

/**
 * Contract of the mxdb subscription wrapper: it layers per-subscription memory (the previous
 * response and handler-owned "additional data") over a nexus subscription, and forgets that
 * memory when the client unsubscribes.
 *
 * Only the nexus boundary is stubbed: `createServerSubscription` hands back the raw socket-level
 * handler so each test can drive it as the socket layer would, and nexus's `useClient` returns a
 * fake socket. The real per-subscription data store is used so the memory is observable.
 */

vi.mock('@anupheaus/nexus/server', async importOriginal => ({
  ...(await importOriginal<object>()),
  createServerSubscription: (_subscription: unknown, handler: unknown) => handler,
  useClient: () => ({ id: 'socket-1' }),
}));

import { createServerCollectionSubscription } from './createServerCollectionSubscription';

// ─── Harness ───────────────────────────────────────────────────────────────────

interface Request { query: string }
type Response = number;
type AdditionalData = string[];

interface HandlerParameters {
  request: Request;
  subscriptionId: string;
  previousResponse: Response | undefined;
  additionalData: AdditionalData | undefined;
  updateAdditionalData(data: AdditionalData): void;
  update(response: Response): void;
  onUnsubscribe(handler: () => void): void;
}

type Handler = (parameters: HandlerParameters) => Response | Promise<Response>;

/** What the nexus socket layer passes to a subscription handler on each subscribe. */
interface SocketLevelParameters {
  request: Request;
  subscriptionId: string;
  update(response: Response): Promise<void>;
  onUnsubscribe(handler: () => void): void;
}

type SocketLevelHandler = (parameters: SocketLevelParameters) => Promise<Response>;

const subscription = { name: 'test.collectionSubscription' } as unknown as NexusSubscription<'test.collectionSubscription', Request, Response>;

let nextSubscriptionNumber = 0;

interface Subscriber {
  subscriptionId: string;
  /** Updates the socket layer emitted to the client. */
  emittedUpdates: Response[];
  /** Subscribe (or re-subscribe) with the same subscription id; resolves to the handler's response. */
  subscribe(request?: Request): Promise<Response>;
  /** Simulate the client unsubscribing. */
  unsubscribe(): void;
}

/** Wraps `handler` and returns a fake socket client bound to one fresh subscription id. */
function createSubscriber(handler: Handler): Subscriber {
  const socketHandler = createServerCollectionSubscription<AdditionalData>()(subscription, handler) as unknown as SocketLevelHandler;
  const subscriptionId = `sub-${++nextSubscriptionNumber}`;
  const emittedUpdates: Response[] = [];
  const unsubscribeHandlers: Array<() => void> = [];
  return {
    subscriptionId,
    emittedUpdates,
    subscribe: (request = { query: 'q' }) => socketHandler({
      request,
      subscriptionId,
      update: async response => { emittedUpdates.push(response); },
      onUnsubscribe: unsubscribeHandler => { unsubscribeHandlers.push(unsubscribeHandler); },
    }),
    unsubscribe: () => { for (const unsubscribeHandler of unsubscribeHandlers.splice(0)) unsubscribeHandler(); },
  };
}

/** A handler that records every parameter set it is called with and returns `responses` in order. */
function recordingHandler(...responses: Response[]): { handler: Handler; calls: HandlerParameters[] } {
  const calls: HandlerParameters[] = [];
  return {
    calls,
    handler: parameters => {
      calls.push(parameters);
      return responses[calls.length - 1] ?? -1;
    },
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('createServerCollectionSubscription', () => {
  it('responds with whatever the handler returns', async () => {
    const subscriber = createSubscriber(() => 42);

    await expect(subscriber.subscribe()).resolves.toBe(42);
  });

  it('responds with the resolved value of an async handler', async () => {
    const subscriber = createSubscriber(async () => 7);

    await expect(subscriber.subscribe()).resolves.toBe(7);
  });

  it('passes the request and subscription id through to the handler', async () => {
    const { handler, calls } = recordingHandler(1);
    const subscriber = createSubscriber(handler);

    await subscriber.subscribe({ query: 'active' });

    expect(calls[0]).toMatchObject({ request: { query: 'active' }, subscriptionId: subscriber.subscriptionId });
  });

  it('has no previous response or additional data on the first subscribe', async () => {
    const { handler, calls } = recordingHandler(1);

    await createSubscriber(handler).subscribe();

    expect([calls[0]!.previousResponse, calls[0]!.additionalData]).toEqual([undefined, undefined]);
  });

  it('remembers the last response as the previous response for the next subscribe', async () => {
    const { handler, calls } = recordingHandler(10, 20);
    const subscriber = createSubscriber(handler);

    await subscriber.subscribe();
    await subscriber.subscribe();

    expect(calls[1]!.previousResponse).toBe(10);
  });

  it('forwards pushed updates to the client', async () => {
    const subscriber = createSubscriber(({ update }) => { update(99); return 1; });

    await subscriber.subscribe();

    expect(subscriber.emittedUpdates).toEqual([99]);
  });

  it('remembers a pushed update as the previous response when it is the latest value', async () => {
    let pushLater!: (response: Response) => void;
    const { handler, calls } = recordingHandler(1, 2);
    const subscriber = createSubscriber(parameters => { pushLater = parameters.update; return handler(parameters); });
    await subscriber.subscribe();

    pushLater(55);
    await subscriber.subscribe();

    expect(calls[1]!.previousResponse).toBe(55);
  });

  it('remembers additional data stored by the handler for the next subscribe', async () => {
    const { handler, calls } = recordingHandler(1, 2);
    const subscriber = createSubscriber(parameters => {
      if (calls.length === 0) parameters.updateAdditionalData(['a', 'b']);
      return handler(parameters);
    });

    await subscriber.subscribe();
    await subscriber.subscribe();

    expect(calls[1]!.additionalData).toEqual(['a', 'b']);
  });

  it('keeps each subscription\'s memory separate', async () => {
    const first = recordingHandler(111);
    const second = recordingHandler(222, 333);
    await createSubscriber(first.handler).subscribe();
    const otherSubscriber = createSubscriber(second.handler);

    await otherSubscriber.subscribe();
    await otherSubscriber.subscribe();

    expect(second.calls.map(call => call.previousResponse)).toEqual([undefined, 222]);
  });

  it('runs the handler\'s unsubscribe callback when the client unsubscribes', async () => {
    const onUnsubscribed = vi.fn();
    const subscriber = createSubscriber(({ onUnsubscribe }) => { onUnsubscribe(onUnsubscribed); return 1; });
    await subscriber.subscribe();

    subscriber.unsubscribe();

    expect(onUnsubscribed).toHaveBeenCalledTimes(1);
  });

  it('forgets the previous response and additional data once the client unsubscribes', async () => {
    const { handler, calls } = recordingHandler(1, 2);
    const subscriber = createSubscriber(parameters => {
      if (calls.length === 0) {
        parameters.updateAdditionalData(['kept-until-unsubscribe']);
        parameters.onUnsubscribe(() => undefined);
      }
      return handler(parameters);
    });
    await subscriber.subscribe();

    subscriber.unsubscribe();
    await subscriber.subscribe();

    expect([calls[1]!.previousResponse, calls[1]!.additionalData]).toEqual([undefined, undefined]);
  });

  it('rejects with the handler\'s error when the handler fails', async () => {
    const subscriber = createSubscriber(() => { throw new Error('query failed'); });

    await expect(subscriber.subscribe()).rejects.toThrow('query failed');
  });

  it('keeps the last successful response as the previous response after a failed subscribe', async () => {
    const calls: HandlerParameters[] = [];
    const subscriber = createSubscriber(parameters => {
      calls.push(parameters);
      if (calls.length === 2) throw new Error('transient');
      return calls.length * 100;
    });
    await subscriber.subscribe();
    await subscriber.subscribe().catch(() => undefined);

    await subscriber.subscribe();

    expect(calls[2]!.previousResponse).toBe(100);
  });
});
