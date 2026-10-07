import { configRegistry, type MXDBCollection } from '../../common';

/**
 * Whether `collection` holds data only the server may see or change (`syncMode: 'ServerOnly'`). `undefined` (a name
 * the database does not register) and a collection with no recorded config are not server-only.
 */
export function isServerOnlyCollection(collection: MXDBCollection | undefined): boolean {
  if (collection == null) return false;
  return configRegistry.get(collection)?.syncMode === 'ServerOnly';
}
