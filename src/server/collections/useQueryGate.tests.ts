import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Record } from '@anupheaus/common';
import { defineCollection } from '../../common/defineCollection';
import type { QueryProps } from '../../common';
import { extendCollection, type OnQueryPayload } from './extendCollection';
import { useQueryGate } from './useQueryGate';

const auth = vi.hoisted(() => ({ userId: undefined as string | undefined, throws: false }));

vi.mock('@anupheaus/nexus/server', async importOriginal => ({
  ...(await importOriginal<object>()),
  useAuthentication: () => {
    if (auth.throws) throw new Error('no auth context');
    return { user: auth.userId == null ? undefined : { id: auth.userId } };
  },
}));

interface Item extends Record {
  ownerId: string;
}

const ungated = defineCollection<Item>({ name: 'query_gate_ungated', indexes: [] });
const gated = defineCollection<Item>({ name: 'query_gate_gated', indexes: [] });

// The registry cannot be cleared, so the gate delegates to a per-test implementation.
const onQuery = vi.fn<(payload: OnQueryPayload) => QueryProps<Item> | void>();
extendCollection(gated, { onQuery: payload => onQuery(payload) });

beforeEach(() => {
  auth.userId = 'u1';
  auth.throws = false;
  onQuery.mockReset();
});

describe('useQueryGate', () => {
  it('leaves the request alone for a collection without a gate, or an unknown collection', async () => {
    const request: QueryProps<Item> = { filters: { ownerId: 'x' } };
    expect(await useQueryGate(ungated).gateRequest(request)).toBe(request);
    expect(await useQueryGate<Item>(undefined).gateRequest(request)).toBe(request);
    expect(await useQueryGate(ungated).getGateFilters()).toBeUndefined();
  });

  it('uses the request unchanged when the gate returns nothing', async () => {
    onQuery.mockReturnValue(undefined);
    const request: QueryProps<Item> = { filters: { ownerId: 'x' } };
    expect(await useQueryGate(gated).gateRequest(request)).toBe(request);
    expect(await useQueryGate(gated).getGateFilters()).toBeUndefined();
  });

  it('gives the gate\'s own filters, from an empty request, for reads that are not a query', async () => {
    onQuery.mockImplementation(({ userId }) => ({ filters: { ownerId: userId ?? 'nobody' } }));
    expect(await useQueryGate(gated).getGateFilters()).toEqual({ ownerId: 'u1' });
    expect(onQuery).toHaveBeenCalledWith({ request: {}, userId: 'u1', purpose: 'read' });
  });

  it('asks the gate as a write when a write is being checked, and as a read otherwise', async () => {
    onQuery.mockImplementation(({ purpose }) => ({ filters: purpose === 'write' ? { ownerId: 'owner' } : { ownerId: 'in-window' } }));
    const { gateRequest, getGateFilters } = useQueryGate(gated);
    expect(await getGateFilters('write')).toEqual({ ownerId: 'owner' });
    expect(await getGateFilters()).toEqual({ ownerId: 'in-window' });
    expect((await gateRequest({})).filters).toEqual({ ownerId: 'in-window' });
  });

  it('treats a gate that adds no filters as not narrowing the read', async () => {
    onQuery.mockImplementation(() => ({ filters: {} }));
    expect(await useQueryGate(gated).getGateFilters()).toBeUndefined();
  });

  it('captures the caller when bound, so a later call outside the request is still scoped to them', async () => {
    onQuery.mockImplementation(({ userId }) => ({ filters: { ownerId: userId ?? 'nobody' } }));
    const { getGateFilters } = useQueryGate(gated);
    auth.throws = true;
    expect(await getGateFilters()).toEqual({ ownerId: 'u1' });
  });

  it('passes an anonymous caller to the gate when there is no auth context', async () => {
    auth.throws = true;
    onQuery.mockReturnValue(undefined);
    await useQueryGate(gated).gateRequest({});
    expect(onQuery).toHaveBeenCalledWith({ request: {}, userId: undefined, purpose: 'read' });
  });
});
