# createUseRecord / createUseRecords Factory Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four factory functions (`createUseRecord` and `createUseRecords` for both client and server) that let consumers build strongly-typed, named hooks on top of mxdb's existing collection primitives.

**Architecture:** Client factories wrap the existing `useRecord` and `useCollection` React hooks and add hydration, named APIs, auto-save (client only), helpers, and extensions. Server factories wrap the server `useCollection` with the same named API pattern but return plain async functions instead of React hooks. Three shared types (`RecordTypeOfCollection`, `ExtensionsType`, `RemoveDasherized`) are extracted to `src/common/models/hookModels.ts` so both sides can reference them without cross-layer imports.

**Tech Stack:** TypeScript, React (client), Vitest, `@testing-library/react` (client tests), `@anupheaus/react-ui` (`useBound`, `useUpdatableState`, `useDebounce`, `useOnUnmount`), `@anupheaus/common` (`is`, `Record`, `AnyObject`)

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/common/models/hookModels.ts` | Shared types: `RecordTypeOfCollection`, `ExtensionsType`, `RemoveDasherized` |
| Modify | `src/common/models/index.ts` | Export `hookModels` |
| Modify | `src/client/useRecord.ts` | Remove `RecordTypeOfCollection` definition; import from common |
| Create | `src/client/hooks/useRecord/createUseRecord.ts` | Client factory — wraps `useRecord`, inlines auto-save |
| Create | `src/client/hooks/useRecord/index.ts` | Re-exports |
| Create | `src/client/hooks/useRecord/createUseRecord.tests.tsx` | Unit tests |
| Create | `src/client/hooks/useRecords/createUseRecords.ts` | Client factory — wraps `useCollection`, reactive query sub-hook |
| Create | `src/client/hooks/useRecords/index.ts` | Re-exports |
| Create | `src/client/hooks/useRecords/createUseRecords.tests.tsx` | Unit tests |
| Modify | `src/client/hooks/index.ts` | Export `useRecord` and `useRecords` folders |
| Create | `src/server/hooks/useRecord/createUseRecord.ts` | Server factory — async, wraps server `useCollection` |
| Create | `src/server/hooks/useRecord/index.ts` | Re-exports |
| Create | `src/server/hooks/useRecord/createUseRecord.tests.ts` | Unit tests |
| Create | `src/server/hooks/useRecords/createUseRecords.ts` | Server factory — sync hook + async `.query()` |
| Create | `src/server/hooks/useRecords/index.ts` | Re-exports |
| Create | `src/server/hooks/useRecords/createUseRecords.tests.ts` | Unit tests |
| Modify | `src/server/hooks/index.ts` | Export `useRecord` and `useRecords` folders |
| Modify | `src/server/index.ts` | Export from `./hooks` |

---

## Task 1: Extract shared types to common

**Files:**
- Create: `src/common/models/hookModels.ts`
- Modify: `src/common/models/index.ts`
- Modify: `src/client/useRecord.ts`

- [ ] **Step 1: Create `src/common/models/hookModels.ts`**

```typescript
import type { Record } from '@anupheaus/common';
import type { MXDBCollection } from './collectionsModels';

export type RecordTypeOfCollection<Collection extends MXDBCollection<Record>> =
  Collection extends MXDBCollection<infer RecordType> ? RecordType : never;

export type ExtensionsType = { [key: string]: (...args: any[]) => any };

export type RemoveDasherized<T extends string> =
  T extends `${infer Prefix}-${infer Suffix}`
    ? RemoveDasherized<`${Prefix}${Capitalize<Suffix>}`>
    : T;
```

- [ ] **Step 2: Export from `src/common/models/index.ts`**

Add one line at the end of the existing file:

```typescript
export * from './hookModels';
```

- [ ] **Step 3: Update `src/client/useRecord.ts`**

Remove the `RecordTypeOfCollection` type definition that is currently at line 8 and import it from common instead. The file currently starts with:

```typescript
import { is, type Record } from '@anupheaus/common';
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MXDBCollection } from '../common';
import { useCollection } from './hooks/useCollection/useCollection';
import { auditor } from '../common/auditor';
import { ConflictResolutionContext } from './providers';

export type RecordTypeOfCollection<Collection extends MXDBCollection<Record>> = Collection extends MXDBCollection<infer RecordType> ? RecordType : never;
```

Replace those imports and the type with:

```typescript
import { is, type Record } from '@anupheaus/common';
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MXDBCollection } from '../common';
import type { RecordTypeOfCollection } from '../common/models';
import { useCollection } from './hooks/useCollection/useCollection';
import { auditor } from '../common/auditor';
import { ConflictResolutionContext } from './providers';
```

- [ ] **Step 4: Verify build passes**

```
pnpm -C c:/code/personal/mxdb build
```

Expected: build succeeds with no type errors.

- [ ] **Step 5: Commit**

```
git -C c:/code/personal/mxdb add src/common/models/hookModels.ts src/common/models/index.ts src/client/useRecord.ts
git -C c:/code/personal/mxdb commit -m "refactor(common): extract RecordTypeOfCollection, ExtensionsType, RemoveDasherized to common/models"
```

---

## Task 2: Client `createUseRecord` — tests

**Files:**
- Create: `src/client/hooks/useRecord/createUseRecord.tests.tsx`

- [ ] **Step 1: Write the failing tests**

Create `src/client/hooks/useRecord/createUseRecord.tests.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createUseRecord } from './createUseRecord';

const mockUpsert = vi.fn();
const mockRemove = vi.fn();

vi.mock('../../useRecord', () => ({
  useRecord: vi.fn().mockReturnValue({
    record: undefined,
    isLoading: false,
    upsert: mockUpsert,
    remove: mockRemove,
  }),
}));

describe('createUseRecord (client)', () => {
  const collection = { name: 'orders', type: {} as any };

  beforeEach(() => vi.clearAllMocks());

  it('hydrates a new record when createNew is true', () => {
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: () => ({ id: 'new-id', name: 'New Order' }),
    });
    const { result } = renderHook(() => useOrder(undefined, true));
    expect(result.current.order).toMatchObject({ name: 'New Order' });
    expect(result.current.isNewOrder).toBe(true);
  });

  it('returns named upsert, remove, set, and autoSave functions', () => {
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: (r) => r ?? { id: '', name: '' },
    });
    const { result } = renderHook(() => useOrder(undefined));
    expect(typeof result.current.upsertOrder).toBe('function');
    expect(typeof result.current.removeOrder).toBe('function');
    expect(typeof result.current.setOrder).toBe('function');
    expect(typeof result.current.autoSaveOrder).toBe('function');
    expect(typeof result.current.isLoadingOrder).toBe('boolean');
    expect(typeof result.current.isNewOrder).toBe('boolean');
  });

  it('attaches extensions as static methods', () => {
    const staticHelper = vi.fn().mockReturnValue('hello');
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: (r) => r ?? { id: '', name: '' },
      extensions: { getDefault: staticHelper },
    });
    expect(typeof (useOrder as any).getDefault).toBe('function');
    (useOrder as any).getDefault();
    expect(staticHelper).toHaveBeenCalled();
  });

  it('merges helpers into the result', () => {
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: (r) => r ?? { id: '', name: '' },
      helpers: () => ({ isSpecial: true }),
    });
    const { result } = renderHook(() => useOrder(undefined));
    expect((result.current as any).isSpecial).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
pnpm -C c:/code/personal/mxdb test --reporter=verbose src/client/hooks/useRecord/createUseRecord.tests.tsx
```

Expected: FAIL — `Cannot find module './createUseRecord'`

---

## Task 3: Client `createUseRecord` — implementation

**Files:**
- Create: `src/client/hooks/useRecord/createUseRecord.ts`
- Create: `src/client/hooks/useRecord/index.ts`

- [ ] **Step 1: Create `src/client/hooks/useRecord/createUseRecord.ts`**

```typescript
import type { AnyObject, Record as CommonRecord } from '@anupheaus/common';
import { is } from '@anupheaus/common';
import type { MXDBCollection } from '../../../common';
import type { ExtensionsType, RecordTypeOfCollection } from '../../../common/models';
import { useRecord as useMXDBRecord } from '../../useRecord';
import { useBound, useDebounce, useOnUnmount, useUpdatableState } from '@anupheaus/react-ui';
import { useLayoutEffect, useMemo, useRef, type Dispatch, type SetStateAction } from 'react';

type AutoSave<T extends CommonRecord> = (record: T) => void;

type CommonUseRecord<Name extends string, T extends CommonRecord> =
  & { [key in Name as `isLoading${Capitalize<Name>}`]: boolean; }
  & { [key in Name as `set${Capitalize<Name>}`]: Dispatch<SetStateAction<T>>; }
  & { [key in Name as `upsert${Capitalize<Name>}`]: (record: T) => Promise<void>; }
  & { [key in Name as `autoSave${Capitalize<Name>}`]: AutoSave<T>; }
  & { [key in Name as `remove${Capitalize<Name>}`]: () => Promise<boolean>; }
  & { [key in Name as `isNew${Capitalize<Name>}`]: boolean; };

export type UseRecord<Name extends string, T extends CommonRecord, Helpers extends AnyObject = {}> = {
  [key in Name]: T | undefined;
} & CommonUseRecord<Name, T> & Helpers;

export type NonNullableUseRecord<Name extends string, T extends CommonRecord, Helpers extends AnyObject = {}> = {
  [key in Name]: T;
} & CommonUseRecord<Name, T> & Helpers;

interface HelpersContext<T extends CommonRecord> {
  recordOrId: T | string | undefined;
}

type HelpersFunction<Name extends string, T extends CommonRecord, HelperResults extends AnyObject> =
  (context: HelpersContext<T> & UseRecord<Name, T>) => HelperResults;

export interface CreateUseRecordOptions<
  Name extends string,
  T extends CommonRecord,
  Args extends unknown[],
  HelperResults extends AnyObject,
  Extensions extends ExtensionsType,
> {
  hydrateRecord(prevRecord: T | undefined, ...args: Args): T;
  helpers?: HelpersFunction<Name, T, HelperResults>;
  extensions?: Extensions;
}

type UseRecordHook<
  Name extends string,
  T extends CommonRecord,
  Args extends unknown[],
  HelperResults extends AnyObject,
  Extensions extends ExtensionsType,
> =
  & ((recordOrId: T | string | undefined) => UseRecord<Name, T, HelperResults>)
  & ((recordOrId: T | string | undefined, createNew: true, ...args: Args) => NonNullableUseRecord<Name, T, HelperResults>)
  & Extensions;

function useStableHelpers<HelperResults extends AnyObject>(rawHelpers: HelperResults | undefined): HelperResults | undefined {
  const latestRef = useRef(rawHelpers);
  latestRef.current = rawHelpers;

  const keysSignature = rawHelpers == null ? '' : Object.keys(rawHelpers).sort().join(',');
  const stableFunctionWrappers = useMemo(() => {
    if (rawHelpers == null) return {};
    const wrappers: AnyObject = {};
    for (const key of Object.keys(rawHelpers)) {
      if (typeof (rawHelpers as AnyObject)[key] === 'function') {
        wrappers[key] = (...args: unknown[]) => (latestRef.current as AnyObject)[key](...args);
      }
    }
    return wrappers;
  }, [keysSignature]);

  if (rawHelpers == null) return undefined;
  return { ...rawHelpers, ...stableFunctionWrappers } as HelperResults;
}

export function createUseRecord<
  Name extends string,
  Collection extends MXDBCollection,
  Args extends unknown[],
  HelperResults extends AnyObject = {},
  Extensions extends ExtensionsType = {},
>(
  name: Name,
  collection: Collection,
  { hydrateRecord, helpers, extensions }: CreateUseRecordOptions<Name, RecordTypeOfCollection<Collection>, Args, HelperResults, Extensions>,
) {
  type T = RecordTypeOfCollection<Collection>;
  const pascalName = name.toPascalCase();

  function useRecord(recordOrId: T | string | undefined): UseRecord<Name, T, HelperResults>;
  function useRecord(recordOrId: T | string | undefined, createNew: true, ...args: Args): NonNullableUseRecord<Name, T, HelperResults>;
  function useRecord(...allArgs: unknown[]): UseRecord<Name, T, HelperResults> {
    const [recordOrId, createNew, ...args] = allArgs;
    const { record: loadedRecord, isLoading: isLoadingRecord, upsert: upsertRecord, remove: removeRecord } =
      useMXDBRecord(recordOrId as any, collection);
    const lastRecordOrIdRef = useRef(recordOrId);
    const isNewRef = useRef(false);

    const [record, setRecord] = useUpdatableState<T | undefined>(prevRecord => {
      if (recordOrId !== lastRecordOrIdRef.current) {
        prevRecord = undefined;
        if (recordOrId == null || loadedRecord != null) lastRecordOrIdRef.current = recordOrId;
      }
      if (loadedRecord == null && !createNew) return prevRecord;
      isNewRef.current = loadedRecord == null && !isLoadingRecord;
      const newRecord = hydrateRecord(
        prevRecord == null && loadedRecord == null ? undefined : { ...prevRecord, ...loadedRecord } as T,
        ...args as Args,
      );
      if (recordOrId != null && newRecord != null) newRecord.id = recordOrId as string;
      return newRecord;
    }, [loadedRecord, isLoadingRecord, recordOrId, ...args]);

    const remove = useBound(async (): Promise<boolean> => {
      if (record == null) return false;
      await removeRecord(record);
      return true;
    });

    // Auto-save: debounces server upserts, flushes on unmount and beforeunload
    const lastAutoSaveRecordRef = useRef<T>();
    const debouncedUpsert = useDebounce(upsertRecord, 30000);
    const flushSave = useBound(async () => {
      if (lastAutoSaveRecordRef.current == null) return;
      await upsertRecord(lastAutoSaveRecordRef.current);
    });
    useOnUnmount(flushSave);
    useLayoutEffect(() => {
      window.addEventListener('beforeunload', flushSave);
      return () => window.removeEventListener('beforeunload', flushSave);
    }, []);
    const autoSave = useBound((updatedRecord: T) => {
      if (is.deepEqual(updatedRecord, lastAutoSaveRecordRef.current)) return;
      lastAutoSaveRecordRef.current = updatedRecord;
      setRecord(updatedRecord);
      debouncedUpsert(updatedRecord);
    });

    const baseResult = {
      [name]: record,
      [`isLoading${pascalName}`]: isLoadingRecord,
      [`set${pascalName}`]: setRecord,
      [`upsert${pascalName}`]: upsertRecord,
      [`remove${pascalName}`]: remove,
      [`isNew${pascalName}`]: isNewRef.current,
      [`autoSave${pascalName}`]: autoSave,
    } as UseRecord<Name, T>;

    const rawHelpers = helpers?.({ recordOrId: recordOrId as T | string | undefined, ...baseResult } as HelpersContext<T> & UseRecord<Name, T>);
    const boundHelpers = useStableHelpers(rawHelpers);

    return { ...baseResult, ...boundHelpers } as UseRecord<Name, T, HelperResults>;
  }

  if (is.plainObject(extensions)) {
    Object.entries(extensions).forEach(([key, fn]) => {
      (useRecord as any)[key] = fn;
    });
  }

  return useRecord as UseRecordHook<Name, T, Args, HelperResults, Extensions>;
}

export type CreateUseRecord<
  Name extends string,
  Collection extends MXDBCollection,
  Args extends unknown[],
  HelperResults extends AnyObject = {},
  Extensions extends ExtensionsType = {},
> = ReturnType<typeof createUseRecord<Name, Collection, Args, HelperResults, Extensions>>;
```

- [ ] **Step 2: Create `src/client/hooks/useRecord/index.ts`**

```typescript
export * from './createUseRecord';
```

- [ ] **Step 3: Run tests to verify they pass**

```
pnpm -C c:/code/personal/mxdb test --reporter=verbose src/client/hooks/useRecord/createUseRecord.tests.tsx
```

Expected: all 4 tests PASS.

- [ ] **Step 4: Commit**

```
git -C c:/code/personal/mxdb add src/client/hooks/useRecord/
git -C c:/code/personal/mxdb commit -m "feat(client): add createUseRecord factory hook with inlined auto-save"
```

---

## Task 4: Client `createUseRecords` — tests

**Files:**
- Create: `src/client/hooks/useRecords/createUseRecords.tests.tsx`

- [ ] **Step 1: Write the failing tests**

Create `src/client/hooks/useRecords/createUseRecords.tests.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createUseRecords } from './createUseRecords';

const mockUpsert = vi.fn();
const mockRemove = vi.fn();
const mockQuery = vi.fn();
const mockGet = vi.fn();
const mockUseQuery = vi.fn();

vi.mock('../useCollection/useCollection', () => ({
  useCollection: () => ({
    upsert: mockUpsert,
    remove: mockRemove,
    query: mockQuery,
    get: mockGet,
    useQuery: mockUseQuery,
  }),
}));

describe('createUseRecords (client)', () => {
  const collection = { name: 'orders', type: {} as any };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQuery.mockReturnValue({ records: [], isLoading: false, total: 0 });
  });

  it('returns named upsert, remove, query, and get functions', () => {
    const useOrders = createUseRecords('orders', collection);
    const { result } = renderHook(() => useOrders());
    expect(typeof result.current.upsertOrders).toBe('function');
    expect(typeof result.current.removeOrders).toBe('function');
    expect(typeof result.current.queryOrders).toBe('function');
    expect(typeof result.current.getOrders).toBe('function');
  });

  it('query hook returns named records, isLoading, and total', () => {
    mockUseQuery.mockReturnValue({ records: [{ id: '1' }], isLoading: true, total: 5 });
    const useOrders = createUseRecords('orders', collection);
    const { result } = renderHook(() => useOrders.query());
    expect(result.current.orders).toEqual([{ id: '1' }]);
    expect(result.current.isLoadingOrders).toBe(true);
    expect(result.current.totalOrders).toBe(5);
  });

  it('query hook with ids builds $in filter', () => {
    const useOrders = createUseRecords('orders', collection);
    renderHook(() => useOrders.query([{ id: '1' }, '2']));
    expect(mockUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({ filters: { id: { $in: ['1', '2'] } } }),
    );
  });

  it('query hook with empty ids array sets disable: true', () => {
    const useOrders = createUseRecords('orders', collection);
    renderHook(() => useOrders.query([]));
    expect(mockUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({ disable: true }),
    );
  });

  it('query hook with QueryProps passes them through', () => {
    const useOrders = createUseRecords('orders', collection);
    renderHook(() => useOrders.query({ filters: { status: 'active' } as any }));
    expect(mockUseQuery).toHaveBeenCalledWith({ filters: { status: 'active' } });
  });

  it('handles dasherized names', () => {
    const useOrderItems = createUseRecords('order-items', collection);
    const { result } = renderHook(() => useOrderItems.query());
    expect(result.current).toHaveProperty('orderItems');
    expect(result.current).toHaveProperty('isLoadingOrderItems');
    expect(result.current).toHaveProperty('totalOrderItems');
  });

  it('merges additionalQueryProps into id-based query', () => {
    const useOrders = createUseRecords('orders', collection, {
      additionalQueryProps: { sorts: [{ field: 'name' as any, direction: 'asc' }] },
    });
    renderHook(() => useOrders.query(['1']));
    expect(mockUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({ sorts: [{ field: 'name', direction: 'asc' }] }),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
pnpm -C c:/code/personal/mxdb test --reporter=verbose src/client/hooks/useRecords/createUseRecords.tests.tsx
```

Expected: FAIL — `Cannot find module './createUseRecords'`

---

## Task 5: Client `createUseRecords` — implementation

**Files:**
- Create: `src/client/hooks/useRecords/createUseRecords.ts`
- Create: `src/client/hooks/useRecords/index.ts`

- [ ] **Step 1: Create `src/client/hooks/useRecords/createUseRecords.ts`**

```typescript
import type { AnyObject, Record } from '@anupheaus/common';
import { is } from '@anupheaus/common';
import type { MXDBCollection, QueryProps } from '../../../common';
import type { ExtensionsType, RecordTypeOfCollection, RemoveDasherized } from '../../../common/models';
import { useCollection } from '../useCollection/useCollection';
import { useMemo, useRef } from 'react';

type UseCollectionResult<T extends Record> = ReturnType<typeof useCollection<T>>;

export type UseRecords<Name extends string, T extends Record, Helpers extends AnyObject = {}> =
  & { [key in Name as `remove${Capitalize<RemoveDasherized<Name>>}`]: (records: T[] | string[]) => Promise<void>; }
  & { [key in Name as `upsert${Capitalize<RemoveDasherized<Name>>}`]: (records: T | T[]) => Promise<void>; }
  & { [key in Name as `query${Capitalize<RemoveDasherized<Name>>}`]: UseCollectionResult<T>['query']; }
  & { [key in Name as `get${Capitalize<RemoveDasherized<Name>>}`]: UseCollectionResult<T>['get']; }
  & Helpers;

export type UseRecordsQuery<Name extends string, T extends Record> =
  & { [key in Name as RemoveDasherized<Name>]: T[]; }
  & { [key in Name as `isLoading${Capitalize<RemoveDasherized<Name>>}`]: boolean; }
  & { [key in Name as `total${Capitalize<RemoveDasherized<Name>>}`]: number; };

const isQueryProps = (arg: unknown): arg is QueryProps<Record> =>
  is.plainObject(arg) && ('filters' in arg || 'disable' in arg || 'sorts' in arg || 'pagination' in arg);

function useStableHelpers<HelperResults extends AnyObject>(rawHelpers: HelperResults | undefined): HelperResults | undefined {
  const latestRef = useRef(rawHelpers);
  latestRef.current = rawHelpers;

  const keysSignature = rawHelpers == null ? '' : Object.keys(rawHelpers).sort().join(',');
  const stableFunctionWrappers = useMemo(() => {
    if (rawHelpers == null) return {};
    const wrappers: AnyObject = {};
    for (const key of Object.keys(rawHelpers)) {
      if (typeof (rawHelpers as AnyObject)[key] === 'function') {
        wrappers[key] = (...args: unknown[]) => (latestRef.current as AnyObject)[key](...args);
      }
    }
    return wrappers;
  }, [keysSignature]);

  if (rawHelpers == null) return undefined;
  return { ...rawHelpers, ...stableFunctionWrappers } as HelperResults;
}

interface UseRecordsOptions<T extends Record, HelperResults extends AnyObject, Extensions extends ExtensionsType> {
  additionalQueryProps?: QueryProps<T>;
  extensions?: Extensions;
  helpers?(): HelperResults;
}

interface QueryHook<Name extends string, T extends Record> {
  (): UseRecordsQuery<Name, T>;
  (recordOrIds: Array<T | string> | undefined): UseRecordsQuery<Name, T>;
  (queryProps: QueryProps<T>): UseRecordsQuery<Name, T>;
}

type UseRecordsHook<Name extends string, T extends Record, Helpers extends AnyObject, Extensions extends ExtensionsType> =
  & (() => UseRecords<Name, T, Helpers>)
  & { query: QueryHook<Name, T> }
  & Extensions;

export function createUseRecords<
  Name extends string,
  Collection extends MXDBCollection,
  HelperResults extends AnyObject = {},
  Extensions extends ExtensionsType = {},
>(
  name: Name,
  collection: Collection,
  {
    additionalQueryProps,
    extensions,
    helpers,
  }: UseRecordsOptions<RecordTypeOfCollection<Collection>, HelperResults, Extensions> = {},
) {
  type T = RecordTypeOfCollection<Collection>;
  const nameAsCamelCase = name.toVariableName();
  const nameAsPascalCase = name.toVariableName('pascal');

  function useRecords(): UseRecords<Name, T, HelperResults> {
    const { upsert, remove, query, get } = useCollection(collection);
    const rawHelpers = helpers?.();
    const helperResults = useStableHelpers(rawHelpers);

    return {
      [`upsert${nameAsPascalCase}`]: upsert,
      [`remove${nameAsPascalCase}`]: remove,
      [`query${nameAsPascalCase}`]: query,
      [`get${nameAsPascalCase}`]: get,
      ...helperResults,
    } as UseRecords<Name, T, HelperResults>;
  }

  function useRecordsQuery(): UseRecordsQuery<Name, T>;
  function useRecordsQuery(recordOrIds: Array<T | string> | undefined): UseRecordsQuery<Name, T>;
  function useRecordsQuery(queryProps: QueryProps<T>): UseRecordsQuery<Name, T>;
  function useRecordsQuery(...args: unknown[]): UseRecordsQuery<Name, T> {
    const { useQuery } = useCollection(collection);
    const recordsOrIds = args[0] instanceof Array ? args[0] as Array<T | string> : undefined;
    const recordIds = recordsOrIds?.map(item => (typeof item === 'string' ? item : (item as Record).id));
    const resolvedQueryProps: QueryProps<T> =
      args.length === 0 ? (additionalQueryProps ?? {}) :
        recordIds != null ? { filters: { id: { $in: recordIds } }, disable: recordIds.length === 0, ...additionalQueryProps } :
          isQueryProps(args[0]) ? args[0] as QueryProps<T> :
            additionalQueryProps ?? {};

    const { records, isLoading, total } = useQuery(resolvedQueryProps);

    return {
      [nameAsCamelCase]: records,
      [`isLoading${nameAsPascalCase}`]: isLoading,
      [`total${nameAsPascalCase}`]: total,
    } as UseRecordsQuery<Name, T>;
  }

  (useRecords as any).query = useRecordsQuery;

  if (is.plainObject(extensions)) {
    Object.entries(extensions).forEach(([key, fn]) => {
      (useRecords as any)[key] = fn;
    });
  }

  return useRecords as UseRecordsHook<Name, T, HelperResults, Extensions>;
}
```

- [ ] **Step 2: Create `src/client/hooks/useRecords/index.ts`**

```typescript
export * from './createUseRecords';
```

- [ ] **Step 3: Run tests to verify they pass**

```
pnpm -C c:/code/personal/mxdb test --reporter=verbose src/client/hooks/useRecords/createUseRecords.tests.tsx
```

Expected: all 7 tests PASS.

- [ ] **Step 4: Commit**

```
git -C c:/code/personal/mxdb add src/client/hooks/useRecords/
git -C c:/code/personal/mxdb commit -m "feat(client): add createUseRecords factory hook with reactive query sub-hook"
```

---

## Task 6: Export client hooks and verify build

**Files:**
- Modify: `src/client/hooks/index.ts`

- [ ] **Step 1: Update `src/client/hooks/index.ts`**

Current content:
```typescript
export * from './useCollection';
export * from './useAuth';
export * from './useMXDBSignOut';
export * from './useMXDBUserId';
```

Replace with:
```typescript
export * from './useCollection';
export * from './useRecord';
export * from './useRecords';
export * from './useAuth';
export * from './useMXDBSignOut';
export * from './useMXDBUserId';
```

- [ ] **Step 2: Verify the build**

```
pnpm -C c:/code/personal/mxdb build
```

Expected: build succeeds, no type errors.

- [ ] **Step 3: Commit**

```
git -C c:/code/personal/mxdb add src/client/hooks/index.ts
git -C c:/code/personal/mxdb commit -m "feat(client): export createUseRecord and createUseRecords from client hooks"
```

---

## Task 7: Server `createUseRecord` — tests

**Files:**
- Create: `src/server/hooks/useRecord/createUseRecord.tests.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/server/hooks/useRecord/createUseRecord.tests.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createUseRecord } from './createUseRecord';

const mockGet = vi.fn();
const mockUpsert = vi.fn();
const mockRemove = vi.fn();

vi.mock('../../collections/useCollection', () => ({
  useCollection: () => ({
    get: mockGet,
    upsert: mockUpsert,
    remove: mockRemove,
  }),
}));

describe('createUseRecord (server)', () => {
  const collection = { name: 'orders', type: {} as any };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue(undefined);
    mockRemove.mockResolvedValue(undefined);
  });

  it('calls hydrateRecord with the loaded record', async () => {
    const hydrateRecord = vi.fn().mockImplementation((r: any) => r ?? { id: '', name: 'New' });
    const useOrder = createUseRecord('order', collection, { hydrateRecord });
    const existing = { id: '1', name: 'Existing' };
    mockGet.mockResolvedValue(existing);
    await useOrder('1');
    expect(hydrateRecord).toHaveBeenCalledWith(existing);
  });

  it('calls hydrateRecord with undefined when id is undefined', async () => {
    const hydrateRecord = vi.fn().mockReturnValue({ id: '', name: 'New' });
    const useOrder = createUseRecord('order', collection, { hydrateRecord });
    await useOrder(undefined);
    expect(mockGet).not.toHaveBeenCalled();
    expect(hydrateRecord).toHaveBeenCalledWith(undefined);
  });

  it('isNewOrder is true when record not found', async () => {
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: (r) => r ?? { id: '', name: 'New' },
    });
    const result = await useOrder('missing-id');
    expect(result.isNewOrder).toBe(true);
  });

  it('isNewOrder is false when record exists', async () => {
    mockGet.mockResolvedValue({ id: '1', name: 'Existing' });
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: (r) => r!,
    });
    const result = await useOrder('1');
    expect(result.isNewOrder).toBe(false);
  });

  it('stamps id onto the hydrated record', async () => {
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: () => ({ id: '', name: 'New' }),
    });
    const result = await useOrder('target-id');
    expect(result.order?.id).toBe('target-id');
  });

  it('removeOrder calls remove with the hydrated record', async () => {
    const existing = { id: '1', name: 'Existing' };
    mockGet.mockResolvedValue(existing);
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: (r) => r!,
    });
    const result = await useOrder('1');
    await result.removeOrder();
    expect(mockRemove).toHaveBeenCalledWith(existing);
  });

  it('removeOrder returns false when record is undefined', async () => {
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: () => undefined as any,
    });
    const result = await useOrder('1');
    const removed = await result.removeOrder();
    expect(removed).toBe(false);
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('merges helper results into the returned object', async () => {
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: (r) => r ?? { id: '', name: 'New' },
      helpers: (ctx) => ({ isSpecial: ctx.order?.name === 'Special' }),
    });
    mockGet.mockResolvedValue({ id: '1', name: 'Special' });
    const result = await useOrder('1');
    expect((result as any).isSpecial).toBe(true);
  });

  it('attaches extensions as static methods', () => {
    const staticFn = vi.fn().mockReturnValue('hello');
    const useOrder = createUseRecord('order', collection, {
      hydrateRecord: (r) => r ?? { id: '', name: '' },
      extensions: { getDefault: staticFn },
    });
    expect(typeof (useOrder as any).getDefault).toBe('function');
    (useOrder as any).getDefault();
    expect(staticFn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
pnpm -C c:/code/personal/mxdb test --reporter=verbose src/server/hooks/useRecord/createUseRecord.tests.ts
```

Expected: FAIL — `Cannot find module './createUseRecord'`

---

## Task 8: Server `createUseRecord` — implementation

**Files:**
- Create: `src/server/hooks/useRecord/createUseRecord.ts`
- Create: `src/server/hooks/useRecord/index.ts`

- [ ] **Step 1: Create `src/server/hooks/useRecord/createUseRecord.ts`**

```typescript
import type { AnyObject, Record as CommonRecord } from '@anupheaus/common';
import { is } from '@anupheaus/common';
import type { MXDBCollection } from '../../../common';
import type { ExtensionsType, RecordTypeOfCollection } from '../../../common/models';
import { useCollection } from '../../collections/useCollection';

type CommonServerUseRecord<Name extends string, T extends CommonRecord> =
  & { [key in Name as `upsert${Capitalize<Name>}`]: (record: T) => Promise<void>; }
  & { [key in Name as `remove${Capitalize<Name>}`]: () => Promise<boolean>; }
  & { [key in Name as `isNew${Capitalize<Name>}`]: boolean; };

export type ServerUseRecord<Name extends string, T extends CommonRecord, Helpers extends AnyObject = {}> = {
  [key in Name]: T | undefined;
} & CommonServerUseRecord<Name, T> & Helpers;

type HelpersFunction<Name extends string, T extends CommonRecord, HelperResults extends AnyObject> =
  (context: ServerUseRecord<Name, T>) => HelperResults;

export interface CreateUseRecordOptions<
  Name extends string,
  T extends CommonRecord,
  Args extends unknown[],
  HelperResults extends AnyObject,
  Extensions extends ExtensionsType,
> {
  hydrateRecord(record: T | undefined, ...args: Args): T;
  helpers?: HelpersFunction<Name, T, HelperResults>;
  extensions?: Extensions;
}

type UseRecordHook<
  Name extends string,
  T extends CommonRecord,
  Args extends unknown[],
  HelperResults extends AnyObject,
  Extensions extends ExtensionsType,
> = ((id: string | undefined, ...args: Args) => Promise<ServerUseRecord<Name, T, HelperResults>>) & Extensions;

export function createUseRecord<
  Name extends string,
  Collection extends MXDBCollection,
  Args extends unknown[],
  HelperResults extends AnyObject = {},
  Extensions extends ExtensionsType = {},
>(
  name: Name,
  collection: Collection,
  { hydrateRecord, helpers, extensions }: CreateUseRecordOptions<Name, RecordTypeOfCollection<Collection>, Args, HelperResults, Extensions>,
) {
  type T = RecordTypeOfCollection<Collection>;
  const pascalName = name.toPascalCase();

  async function useRecord(id: string | undefined, ...args: Args): Promise<ServerUseRecord<Name, T, HelperResults>> {
    const { get, upsert, remove } = useCollection(collection);
    const loadedRecord = id != null ? await get(id) : undefined;
    const record = hydrateRecord(loadedRecord, ...args);
    if (id != null && record != null) (record as CommonRecord).id = id;
    const isNew = loadedRecord == null;

    const removeFn = async (): Promise<boolean> => {
      if (record == null) return false;
      await remove(record);
      return true;
    };

    const baseResult = {
      [name]: record,
      [`upsert${pascalName}`]: upsert,
      [`remove${pascalName}`]: removeFn,
      [`isNew${pascalName}`]: isNew,
    } as ServerUseRecord<Name, T>;

    const helperResults = helpers?.(baseResult);

    return { ...baseResult, ...helperResults } as ServerUseRecord<Name, T, HelperResults>;
  }

  if (is.plainObject(extensions)) {
    Object.entries(extensions).forEach(([key, fn]) => {
      (useRecord as any)[key] = fn;
    });
  }

  return useRecord as UseRecordHook<Name, T, Args, HelperResults, Extensions>;
}

export type CreateUseRecord<
  Name extends string,
  Collection extends MXDBCollection,
  Args extends unknown[],
  HelperResults extends AnyObject = {},
  Extensions extends ExtensionsType = {},
> = ReturnType<typeof createUseRecord<Name, Collection, Args, HelperResults, Extensions>>;
```

- [ ] **Step 2: Create `src/server/hooks/useRecord/index.ts`**

```typescript
export * from './createUseRecord';
```

- [ ] **Step 3: Run tests to verify they pass**

```
pnpm -C c:/code/personal/mxdb test --reporter=verbose src/server/hooks/useRecord/createUseRecord.tests.ts
```

Expected: all 9 tests PASS.

- [ ] **Step 4: Commit**

```
git -C c:/code/personal/mxdb add src/server/hooks/useRecord/
git -C c:/code/personal/mxdb commit -m "feat(server): add createUseRecord async factory hook"
```

---

## Task 9: Server `createUseRecords` — tests

**Files:**
- Create: `src/server/hooks/useRecords/createUseRecords.tests.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/server/hooks/useRecords/createUseRecords.tests.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createUseRecords } from './createUseRecords';

const mockQuery = vi.fn();
const mockGetAll = vi.fn();
const mockUpsert = vi.fn();
const mockRemove = vi.fn();
const mockGet = vi.fn();
const mockFind = vi.fn();
const mockDistinct = vi.fn();

vi.mock('../../collections/useCollection', () => ({
  useCollection: () => ({
    query: mockQuery,
    getAll: mockGetAll,
    upsert: mockUpsert,
    remove: mockRemove,
    get: mockGet,
    find: mockFind,
    distinct: mockDistinct,
  }),
}));

describe('createUseRecords (server)', () => {
  const collection = { name: 'orders', type: {} as any };

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ records: [], total: 0 });
  });

  it('returns named action functions', () => {
    const useOrders = createUseRecords('orders', collection);
    const result = useOrders();
    expect(typeof result.queryOrders).toBe('function');
    expect(typeof result.upsertOrders).toBe('function');
    expect(typeof result.removeOrders).toBe('function');
    expect(typeof result.getOrders).toBe('function');
    expect(typeof result.getAllOrders).toBe('function');
    expect(typeof result.findOrders).toBe('function');
    expect(typeof result.distinctOrders).toBe('function');
  });

  it('query helper with no args calls underlying query with empty props', async () => {
    const useOrders = createUseRecords('orders', collection);
    await useOrders.query();
    expect(mockQuery).toHaveBeenCalledWith({});
  });

  it('query helper returns named records and total', async () => {
    mockQuery.mockResolvedValue({ records: [{ id: '1', name: 'A' }], total: 3 });
    const useOrders = createUseRecords('orders', collection);
    const result = await useOrders.query();
    expect(result.orders).toEqual([{ id: '1', name: 'A' }]);
    expect(result.totalOrders).toBe(3);
  });

  it('query helper with ids builds $in filter', async () => {
    const useOrders = createUseRecords('orders', collection);
    await useOrders.query([{ id: '1' } as any, '2']);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({ filters: { id: { $in: ['1', '2'] } } }),
    );
  });

  it('query helper with QueryProps passes them through', async () => {
    const useOrders = createUseRecords('orders', collection);
    await useOrders.query({ filters: { status: 'active' } as any });
    expect(mockQuery).toHaveBeenCalledWith({ filters: { status: 'active' } });
  });

  it('merges additionalQueryProps into id-based query', async () => {
    const useOrders = createUseRecords('orders', collection, {
      additionalQueryProps: { sorts: [{ field: 'name' as any, direction: 'asc' }] },
    });
    await useOrders.query(['1']);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({ sorts: [{ field: 'name', direction: 'asc' }] }),
    );
  });

  it('handles dasherized names', async () => {
    const useOrderItems = createUseRecords('order-items', collection);
    const result = await useOrderItems.query();
    expect(result).toHaveProperty('orderItems');
    expect(result).toHaveProperty('totalOrderItems');
  });

  it('merges helper results into the returned object', () => {
    const useOrders = createUseRecords('orders', collection, {
      helpers: () => ({ isAdmin: true }),
    });
    const result = useOrders();
    expect((result as any).isAdmin).toBe(true);
  });

  it('attaches extensions as static methods', () => {
    const staticFn = vi.fn().mockReturnValue('hello');
    const useOrders = createUseRecords('orders', collection, {
      extensions: { getDefault: staticFn },
    });
    expect(typeof (useOrders as any).getDefault).toBe('function');
    (useOrders as any).getDefault();
    expect(staticFn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
pnpm -C c:/code/personal/mxdb test --reporter=verbose src/server/hooks/useRecords/createUseRecords.tests.ts
```

Expected: FAIL — `Cannot find module './createUseRecords'`

---

## Task 10: Server `createUseRecords` — implementation

**Files:**
- Create: `src/server/hooks/useRecords/createUseRecords.ts`
- Create: `src/server/hooks/useRecords/index.ts`

- [ ] **Step 1: Create `src/server/hooks/useRecords/createUseRecords.ts`**

```typescript
import type { AnyObject, DataFilters, Record } from '@anupheaus/common';
import { is } from '@anupheaus/common';
import type { MXDBCollection, QueryProps, QueryResults } from '../../../common';
import type { ExtensionsType, RecordTypeOfCollection, RemoveDasherized } from '../../../common/models';
import { useCollection } from '../../collections/useCollection';

export type ServerUseRecords<Name extends string, T extends Record, Helpers extends AnyObject = {}> =
  & { [key in Name as `query${Capitalize<RemoveDasherized<Name>>}`]: (props?: QueryProps<T>) => Promise<QueryResults<T>>; }
  & { [key in Name as `getAll${Capitalize<RemoveDasherized<Name>>}`]: () => Promise<T[]>; }
  & { [key in Name as `upsert${Capitalize<RemoveDasherized<Name>>}`]: (records: T | T[]) => Promise<void>; }
  & { [key in Name as `remove${Capitalize<RemoveDasherized<Name>>}`]: (records: T | T[] | string | string[]) => Promise<void>; }
  & { [key in Name as `get${Capitalize<RemoveDasherized<Name>>}`]: (id: string) => Promise<T | undefined>; }
  & { [key in Name as `find${Capitalize<RemoveDasherized<Name>>}`]: (filters: DataFilters<T>) => Promise<T | undefined>; }
  & { [key in Name as `distinct${Capitalize<RemoveDasherized<Name>>}`]: <K extends keyof T>(field: K, props?: { filters?: DataFilters<T> }) => Promise<T[K][]>; }
  & Helpers;

export type ServerUseRecordsQuery<Name extends string, T extends Record> =
  & { [key in Name as RemoveDasherized<Name>]: T[]; }
  & { [key in Name as `total${Capitalize<RemoveDasherized<Name>>}`]: number; };

const isQueryProps = (arg: unknown): arg is QueryProps<Record> =>
  is.plainObject(arg) && ('filters' in arg || 'disable' in arg || 'sorts' in arg || 'pagination' in arg);

interface UseRecordsOptions<T extends Record, HelperResults extends AnyObject, Extensions extends ExtensionsType> {
  additionalQueryProps?: QueryProps<T>;
  extensions?: Extensions;
  helpers?(): HelperResults;
}

type QueryFn<Name extends string, T extends Record> = {
  (): Promise<ServerUseRecordsQuery<Name, T>>;
  (recordOrIds: Array<T | string>): Promise<ServerUseRecordsQuery<Name, T>>;
  (queryProps: QueryProps<T>): Promise<ServerUseRecordsQuery<Name, T>>;
};

type UseRecordsHook<Name extends string, T extends Record, Helpers extends AnyObject, Extensions extends ExtensionsType> =
  & (() => ServerUseRecords<Name, T, Helpers>)
  & { query: QueryFn<Name, T> }
  & Extensions;

export function createUseRecords<
  Name extends string,
  Collection extends MXDBCollection,
  HelperResults extends AnyObject = {},
  Extensions extends ExtensionsType = {},
>(
  name: Name,
  collection: Collection,
  {
    additionalQueryProps,
    extensions,
    helpers,
  }: UseRecordsOptions<RecordTypeOfCollection<Collection>, HelperResults, Extensions> = {},
) {
  type T = RecordTypeOfCollection<Collection>;
  const nameAsCamelCase = name.toVariableName();
  const nameAsPascalCase = name.toVariableName('pascal');

  function useRecords(): ServerUseRecords<Name, T, HelperResults> {
    const { upsert, remove, query, get, getAll, find, distinct } = useCollection(collection);
    const helperResults = helpers?.();

    return {
      [`query${nameAsPascalCase}`]: query,
      [`getAll${nameAsPascalCase}`]: getAll,
      [`upsert${nameAsPascalCase}`]: upsert,
      [`remove${nameAsPascalCase}`]: remove,
      [`get${nameAsPascalCase}`]: get,
      [`find${nameAsPascalCase}`]: find,
      [`distinct${nameAsPascalCase}`]: distinct,
      ...helperResults,
    } as ServerUseRecords<Name, T, HelperResults>;
  }

  async function useRecordsQuery(): Promise<ServerUseRecordsQuery<Name, T>>;
  async function useRecordsQuery(recordOrIds: Array<T | string>): Promise<ServerUseRecordsQuery<Name, T>>;
  async function useRecordsQuery(queryProps: QueryProps<T>): Promise<ServerUseRecordsQuery<Name, T>>;
  async function useRecordsQuery(...args: unknown[]): Promise<ServerUseRecordsQuery<Name, T>> {
    const { query } = useCollection(collection);
    const recordsOrIds = args[0] instanceof Array ? args[0] as Array<T | string> : undefined;
    const recordIds = recordsOrIds?.map(item => (typeof item === 'string' ? item : (item as Record).id));
    const resolvedQueryProps: QueryProps<T> =
      args.length === 0 ? (additionalQueryProps ?? {}) :
        recordIds != null ? { filters: { id: { $in: recordIds } }, ...additionalQueryProps } :
          isQueryProps(args[0]) ? args[0] as QueryProps<T> :
            additionalQueryProps ?? {};

    const { records, total } = await query(resolvedQueryProps);

    return {
      [nameAsCamelCase]: records,
      [`total${nameAsPascalCase}`]: total,
    } as ServerUseRecordsQuery<Name, T>;
  }

  (useRecords as any).query = useRecordsQuery;

  if (is.plainObject(extensions)) {
    Object.entries(extensions).forEach(([key, fn]) => {
      (useRecords as any)[key] = fn;
    });
  }

  return useRecords as UseRecordsHook<Name, T, HelperResults, Extensions>;
}
```

- [ ] **Step 2: Create `src/server/hooks/useRecords/index.ts`**

```typescript
export * from './createUseRecords';
```

- [ ] **Step 3: Run tests to verify they pass**

```
pnpm -C c:/code/personal/mxdb test --reporter=verbose src/server/hooks/useRecords/createUseRecords.tests.ts
```

Expected: all 9 tests PASS.

- [ ] **Step 4: Commit**

```
git -C c:/code/personal/mxdb add src/server/hooks/useRecords/
git -C c:/code/personal/mxdb commit -m "feat(server): add createUseRecords factory hook with async query helper"
```

---

## Task 11: Export server hooks and verify full build

**Files:**
- Modify: `src/server/hooks/index.ts`
- Modify: `src/server/index.ts`

- [ ] **Step 1: Update `src/server/hooks/index.ts`**

Current content:
```typescript
export * from './useClient';
export * from './useAuditor';
```

Replace with:
```typescript
export * from './useClient';
export * from './useAuditor';
export * from './useRecord';
export * from './useRecords';
```

- [ ] **Step 2: Update `src/server/index.ts`**

Current content:
```typescript
export * from './startServer';
export * from './collections';
export type { MXDBDeviceInfo } from '../common/models';
export { useAuth } from './auth/useAuth';
```

Replace with:
```typescript
export * from './startServer';
export * from './collections';
export * from './hooks';
export type { MXDBDeviceInfo } from '../common/models';
export { useAuth } from './auth/useAuth';
```

- [ ] **Step 3: Run the full unit test suite**

```
pnpm -C c:/code/personal/mxdb test
```

Expected: all tests pass with no regressions.

- [ ] **Step 4: Verify build**

```
pnpm -C c:/code/personal/mxdb build
```

Expected: build succeeds with no type errors.

- [ ] **Step 5: Commit**

```
git -C c:/code/personal/mxdb add src/server/hooks/index.ts src/server/index.ts
git -C c:/code/personal/mxdb commit -m "feat(server): export createUseRecord and createUseRecords from server package"
```
