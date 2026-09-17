import type { Logger } from '@anupheaus/common';
import type { MXDBCollectionConfig } from '../../../common/models';
import { Db } from './Db';
import '@anupheaus/common';


class Dbs {
  constructor() {
    this.#dbs = new Map<string, Db>();
  }

  #dbs: Map<string, Db>;

  public open(
    name: string,
    collections: MXDBCollectionConfig[],
    encryptionKey?: Uint8Array,
    logger?: Logger,
  ) {
    const existedBefore = this.#dbs.has(name); // [LOCK-DIAG]
    const db = this.#dbs.getOrSet(name, () => new Db(name, collections, encryptionKey, logger));
    console.warn('[LOCK-DIAG] Dbs.open', { t: Date.now(), name, reusedExisting: existedBefore }); // [LOCK-DIAG]
    return db;
  }

  public async close(name: string) {
    console.warn('[LOCK-DIAG] Dbs.close START', { t: Date.now(), name, present: this.#dbs.has(name) }); // [LOCK-DIAG]
    if (!this.#dbs.has(name)) return;
    const db = this.#dbs.get(name);
    if (db != null) await db.close();
    this.#dbs.delete(name);
    console.warn('[LOCK-DIAG] Dbs.close DONE (deleted from map)', { t: Date.now(), name }); // [LOCK-DIAG]
  }
}

export const dbs = new Dbs();
