import { describe, expect, it } from 'vitest';
import type { QueryProps, QueryRequest, ServerQueryHints } from './collectionsModels';

/**
 * `serverHints` is a server-only, typed metadata channel on a query. These tests
 * pin the *type contract* a caller relies on: hints are optional, strongly typed
 * via the second generic, default to an open string-keyed shape, and survive onto
 * `QueryRequest` (the over-the-wire form that adds `collectionName`).
 */
describe('QueryProps.serverHints — type contract', () => {
  interface Hints extends ServerQueryHints {
    latestPerSchedule?: boolean;
    scope?: 'mine' | 'all';
  }

  it('accepts typed server hints alongside filters', () => {
    const props: QueryProps<{ id: string }, Hints> = {
      filters: { id: 'a' },
      serverHints: { latestPerSchedule: true, scope: 'mine' },
    };
    expect(props.serverHints).toEqual({ latestPerSchedule: true, scope: 'mine' });
  });

  it('treats serverHints as optional — a query without it is valid', () => {
    const props: QueryProps<{ id: string }, Hints> = { filters: { id: 'a' } };
    expect(props.serverHints).toBeUndefined();
  });

  it('defaults to an open string-keyed hint shape when no Hints generic is given', () => {
    const props: QueryProps<{ id: string }> = {
      serverHints: { anyKey: 1, another: 'value', flag: true },
    };
    expect(props.serverHints).toEqual({ anyKey: 1, another: 'value', flag: true });
  });

  it('carries serverHints onto QueryRequest alongside collectionName', () => {
    const request: QueryRequest<{ id: string }, Hints> = {
      collectionName: 'items',
      filters: { id: 'a' },
      serverHints: { scope: 'all' },
    };
    expect(request.collectionName).toBe('items');
    expect(request.serverHints).toEqual({ scope: 'all' });
  });
});
