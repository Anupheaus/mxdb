/** The storage-only field mxdb keeps beside each live document (see `MXDBStoredMeta`). */
const STORED_META_FIELD = '_meta';

interface ChangeWithUpdateDescription {
  operationType?: string;
  updateDescription?: {
    updatedFields?: object;
    removedFields?: string[];
    truncatedArrays?: { field: string }[];
  };
}

/** Whether a field path is the stored metadata or inside it. */
function isStoredMetaPath(fieldPath: string): boolean {
  return fieldPath === STORED_META_FIELD || fieldPath.startsWith(`${STORED_META_FIELD}.`);
}

/**
 * Whether a change-stream event is an `update` that touched only the stored metadata (`_meta`), so the record itself did
 * not change: e.g. mxdb clearing a stale stored hash. Such a change is nothing to tell clients or hooks about.
 */
export function isStoredMetaOnlyChange(change: ChangeWithUpdateDescription): boolean {
  if (change.operationType !== 'update' || change.updateDescription == null) return false;
  const { updatedFields = {}, removedFields = [], truncatedArrays = [] } = change.updateDescription;
  const changedPaths = [...Object.keys(updatedFields), ...removedFields, ...truncatedArrays.map(({ field }) => field)];
  return changedPaths.length > 0 && changedPaths.every(isStoredMetaPath);
}
