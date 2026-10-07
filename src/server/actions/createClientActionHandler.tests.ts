import { describe, it, expect, vi, beforeEach } from 'vitest';
import { defineAction } from '@anupheaus/nexus/common';
import { createClientActionHandler } from './createClientActionHandler';

const h = vi.hoisted(() => ({ refuse: vi.fn() }));

vi.mock('../collections/refuseServerOnlyCollections', () => ({
  refuseServerOnlyCollections: h.refuse,
}));

interface ProbeRequest { collectionName: string }
// nexus registers each action name once per process, so each test gets its own action.
const answeredAction = defineAction<ProbeRequest, string>()('probeAnsweredAction');
const refusedAction = defineAction<ProbeRequest, string>()('probeRefusedAction');

beforeEach(() => {
  h.refuse.mockReset();
});

describe('createClientActionHandler', () => {
  it('checks the request before the handler runs, naming the action', async () => {
    const handler = vi.fn(async () => 'answered');
    const { restEntry } = createClientActionHandler(answeredAction, handler);
    const request = { collectionName: 'items' };
    expect(await restEntry.handler(request, {} as never)).toBe('answered');
    expect(h.refuse).toHaveBeenCalledWith({ requestName: 'probeAnsweredAction', request });
    expect(handler).toHaveBeenCalledWith(request);
  });

  it('never runs the handler for a refused request', async () => {
    h.refuse.mockImplementation(() => { throw new Error('refused'); });
    const handler = vi.fn(async () => 'answered');
    const { restEntry } = createClientActionHandler(refusedAction, handler);
    await expect(Promise.resolve().then(() => restEntry.handler({ collectionName: 'tokens' }, {} as never))).rejects.toThrow('refused');
    expect(handler).not.toHaveBeenCalled();
  });
});
