import type { AnyObject, DataFilters, Record as CommonRecord } from '@anupheaus/common';
import { InternalError, is } from '@anupheaus/common';
import type { MXDBCollection, MXDBError, QueryProps } from '../../../common';
import type { AddDebugTo, AddDisableTo, ExtensionsType, RecordTypeOfCollection, RemoveDasherized } from '../../../common/models';
import { useCollection } from '../useCollection/useCollection';
import { useRecord as useMXDBRecord } from '../../useRecord';
import { useBound, useOnUnmount, useUpdatableState } from '@anupheaus/react-ui';
import { useLayoutEffect, useMemo, useRef, type Dispatch, type SetStateAction } from 'react';
import { useStableHelpers } from '../useStableHelpers';

type AutoSaveConfig = { debounceMS?: number };
type AutoSave<T extends CommonRecord> = ((record: T) => void) & {
  withConfig(config?: AutoSaveConfig): (record: T) => void;
};

type CommonUseRecord<Name extends string, T extends CommonRecord> =
  & { [key in Name as `isLoading${Capitalize<RemoveDasherized<Name>>}`]: boolean; }
  & { [key in Name as `set${Capitalize<RemoveDasherized<Name>>}`]: Dispatch<SetStateAction<T>>; }
  & { [key in Name as `upsert${Capitalize<RemoveDasherized<Name>>}`]: (record: T) => Promise<void>; }
  & { [key in Name as `autoSave${Capitalize<RemoveDasherized<Name>>}`]: AutoSave<T>; }
  & { [key in Name as `remove${Capitalize<RemoveDasherized<Name>>}`]: () => Promise<boolean>; }
  & { [key in Name as `isNew${Capitalize<RemoveDasherized<Name>>}`]: boolean; };

export type UseRecord<Name extends string, T extends CommonRecord, Helpers extends AnyObject = {}> = {
  [key in Name as RemoveDasherized<Name>]: T | undefined;
} & CommonUseRecord<Name, T> & Helpers;

export type NonNullableUseRecord<Name extends string, T extends CommonRecord, Helpers extends AnyObject = {}> = {
  [key in Name as RemoveDasherized<Name>]: T;
} & CommonUseRecord<Name, T> & Helpers;

type UseStaticGet<Name extends string, T extends CommonRecord> =
  & { [key in Name as RemoveDasherized<Name>]: T | undefined; }
  & { [key in Name as `isLoading${Capitalize<RemoveDasherized<Name>>}`]: boolean; }
  & { error?: MXDBError; };

type UseStaticGetAll<Name extends string, T extends CommonRecord> =
  & { [key in Name as RemoveDasherized<Name>]: T[]; }
  & { [key in Name as `isLoading${Capitalize<RemoveDasherized<Name>>}`]: boolean; }
  & { error?: MXDBError; };

type UseStaticFind<Name extends string, T extends CommonRecord> =
  & { [key in Name as RemoveDasherized<Name>]: T | undefined; }
  & { [key in Name as `isLoading${Capitalize<RemoveDasherized<Name>>}`]: boolean; };

type UseStaticQuery<Name extends string, T extends CommonRecord> =
  & { [key in Name as RemoveDasherized<Name>]: T[]; }
  & { [key in Name as `isLoading${Capitalize<RemoveDasherized<Name>>}`]: boolean; }
  & { [key in Name as `total${Capitalize<RemoveDasherized<Name>>}`]: number; };

type UseStaticDistinct<Name extends string, T extends CommonRecord, K extends keyof T = keyof T> =
  & { values: T[K][]; error?: MXDBError; }
  & { [key in Name as `isLoading${Capitalize<RemoveDasherized<Name>>}`]: boolean; };

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
  & { get: (id: string | undefined) => UseStaticGet<Name, T> }
  & { getAll: (props?: AddDebugTo<AddDisableTo<object>>) => UseStaticGetAll<Name, T> }
  & { find: (filters: DataFilters<T>) => UseStaticFind<Name, T> }
  & { query: (queryProps?: QueryProps<T>) => UseStaticQuery<Name, T> }
  & { distinct: <K extends keyof T>(field: K) => UseStaticDistinct<Name, T, K> }
  & Extensions;

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
  const pascalName = name.toVariableName('pascal');
  const camelName = name.toVariableName();

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
      const idToStamp = typeof recordOrId === 'string' ? recordOrId : recordOrId != null ? (recordOrId as CommonRecord).id : undefined;
      if (idToStamp != null && newRecord != null) newRecord.id = idToStamp;
      return newRecord;
    }, [loadedRecord, isLoadingRecord, recordOrId, ...args]);

    const remove = useBound(async (): Promise<boolean> => {
      if (record == null) return false;
      await removeRecord(record);
      return true;
    });

    // Auto-save: debounces server upserts, flushes on unmount and beforeunload.
    // Guards against persisting the hydrated placeholder while an existing record
    // is still loading (which would overwrite the real record with empty data).
    const DEFAULT_AUTO_SAVE_DEBOUNCE_MS = 30000;
    const lastAutoSaveRecordRef = useRef<T>();
    const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout>>();

    // Latches true once loading has settled (loaded existing OR confirmed new).
    const hasLoadedRef = useRef(false);
    if (!isLoadingRecord) hasLoadedRef.current = true;

    const flushSave = useBound(async () => {
      if (autoSaveTimerRef.current != null) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = undefined;
      }
      if (!hasLoadedRef.current) return;
      if (lastAutoSaveRecordRef.current == null) return;
      const recordToSave = lastAutoSaveRecordRef.current;
      lastAutoSaveRecordRef.current = undefined;
      await upsertRecord(recordToSave);
    });
    useOnUnmount(() => void flushSave());
    useLayoutEffect(() => {
      window.addEventListener('beforeunload', flushSave);
      return () => window.removeEventListener('beforeunload', flushSave);
    }, []);

    const scheduleAutoSave = useBound((updatedRecord: T, debounceMS: number) => {
      if (!hasLoadedRef.current) return;
      if (is.deepEqual(updatedRecord, lastAutoSaveRecordRef.current)) return;
      lastAutoSaveRecordRef.current = updatedRecord;
      setRecord(updatedRecord);
      if (autoSaveTimerRef.current != null) clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = setTimeout(() => { void flushSave(); }, debounceMS);
    });

    const autoSave = useMemo(() => {
      const fn = ((updatedRecord: T) => scheduleAutoSave(updatedRecord, DEFAULT_AUTO_SAVE_DEBOUNCE_MS)) as AutoSave<T>;
      fn.withConfig = ({ debounceMS = DEFAULT_AUTO_SAVE_DEBOUNCE_MS }: AutoSaveConfig = {}) =>
        (updatedRecord: T) => scheduleAutoSave(updatedRecord, debounceMS);
      return fn;
    }, [scheduleAutoSave]);

    // Guard explicit upserts against the wipe: while this record is still loading, `record`
    // is only the hydrated placeholder, so upserting THIS id would overwrite the real
    // (not-yet-loaded) record with empty data. Surface that loudly rather than silently
    // corrupting. Upserting a different record through this hook is allowed.
    const loadingId = typeof recordOrId === 'string'
      ? recordOrId
      : recordOrId != null ? (recordOrId as CommonRecord).id : undefined;
    const upsert = useBound(async (recordToUpsert: T): Promise<void> => {
      if (!hasLoadedRef.current && loadingId != null && recordToUpsert?.id === loadingId) {
        throw new InternalError(`Cannot upsert "${collection.name}" record "${loadingId}" while it is still loading; this would overwrite it with unloaded data.`);
      }
      await upsertRecord(recordToUpsert);
    });

    const baseResult = {
      [camelName]: record,
      [`isLoading${pascalName}`]: isLoadingRecord,
      [`set${pascalName}`]: setRecord,
      [`upsert${pascalName}`]: upsert,
      [`remove${pascalName}`]: remove,
      [`isNew${pascalName}`]: isNewRef.current,
      [`autoSave${pascalName}`]: autoSave,
    } as UseRecord<Name, T>;

    const rawHelpers = helpers?.({ recordOrId: recordOrId as T | string | undefined, ...baseResult } as HelpersContext<T> & UseRecord<Name, T>);
    const boundHelpers = useStableHelpers(rawHelpers);

    return { ...baseResult, ...boundHelpers } as UseRecord<Name, T, HelperResults>;
  }

  function useRecordGet(id: string | undefined): UseStaticGet<Name, T> {
    const { useGet } = useCollection(collection);
    const { record, isLoading, error } = useGet(id);
    return {
      [camelName]: record,
      [`isLoading${pascalName}`]: isLoading,
      error,
    } as UseStaticGet<Name, T>;
  }

  function useRecordGetAll(props?: AddDebugTo<AddDisableTo<object>>): UseStaticGetAll<Name, T> {
    const { useGetAll } = useCollection(collection);
    const { records, isLoading, error } = useGetAll(props);
    return {
      [camelName]: records,
      [`isLoading${pascalName}`]: isLoading,
      error,
    } as UseStaticGetAll<Name, T>;
  }

  function useRecordFind(filters: DataFilters<T>): UseStaticFind<Name, T> {
    const { useQuery } = useCollection(collection);
    const { records, isLoading } = useQuery({ filters });
    return {
      [camelName]: records[0] as T | undefined,
      [`isLoading${pascalName}`]: isLoading,
    } as UseStaticFind<Name, T>;
  }

  function useRecordQuery(queryProps?: QueryProps<T>): UseStaticQuery<Name, T> {
    const { useQuery } = useCollection(collection);
    const { records, isLoading, total } = useQuery(queryProps ?? {});
    return {
      [camelName]: records,
      [`isLoading${pascalName}`]: isLoading,
      [`total${pascalName}`]: total,
    } as UseStaticQuery<Name, T>;
  }

  function useRecordDistinct<K extends keyof T>(field: K): UseStaticDistinct<Name, T, K> {
    const { useDistinct } = useCollection(collection);
    const { values, isLoading, error } = useDistinct(field);
    return {
      values: values as T[K][],
      [`isLoading${pascalName}`]: isLoading,
      error,
    } as UseStaticDistinct<Name, T, K>;
  }

  (useRecord as any).get = useRecordGet;
  (useRecord as any).getAll = useRecordGetAll;
  (useRecord as any).find = useRecordFind;
  (useRecord as any).query = useRecordQuery;
  (useRecord as any).distinct = useRecordDistinct;

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
