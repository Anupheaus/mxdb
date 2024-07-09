import { Record } from '@anupheaus/common';
import { utils } from './utils';
import { useDb } from './DbContext';

export function createGet<RecordType extends Record>(name: string) {
  const { db } = useDb();
  return async function get(id: string) {

    const col = db.transaction(name, 'readonly').objectStore(name);
    return utils.wrap<RecordType | undefined>(col.get(id));
  };
}

export type Get<RecordType extends Record = Record> = ReturnType<typeof createGet<RecordType>>;