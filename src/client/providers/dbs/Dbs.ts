import type { Logger } from '@anupheaus/common';
import type { MXDBCollectionConfig } from '../../../common/models';
import { Db } from './Db';
import '@anupheaus/common';


class Dbs {
  constructor() {
    this.#dbs = new Map<string, Db>();
    this.#closing = new Map<string, Promise<void>>();
  }

  #dbs: Map<string, Db>;
  /** In-flight close per database name — a Db opened meanwhile waits for it (see `close`). */
  #closing: Map<string, Promise<void>>;

  public open(
    name: string,
    collections: MXDBCollectionConfig[],
    encryptionKey?: Uint8Array,
    logger?: Logger,
  ) {
    const existing = this.#dbs.get(name);
    console.warn('[LOCK-DIAG] Dbs.open', { t: Date.now(), name, reusedExisting: existing != null, waitsForClose: this.#closing.has(name) }); // [LOCK-DIAG]
    if (existing != null) return existing;
    const db = new Db(name, collections, encryptionKey, logger, this.#closing.get(name));
    this.#dbs.set(name, db);
    return db;
  }

  /**
   * Closes the named database. The entry is removed from the map SYNCHRONOUSLY, before the close is
   * awaited: `DbsProvider` calls `close` then `open` without awaiting (a re-run when the encryption key
   * changes, e.g. applied twice straight after registration). Previously `open` got back the instance
   * still closing, and the close then deleted the map entry — leaving the provider on a closed Db, so
   * every query hung ("Authenticating, please wait..." forever). Instead `open` now builds a fresh Db,
   * which waits for this close before opening the file: the shared worker holds one handle per
   * database, so an overlapping close would tear down the handle the new Db had just opened.
   */
  public close(name: string): Promise<void> {
    const db = this.#dbs.get(name);
    console.warn('[LOCK-DIAG] Dbs.close START', { t: Date.now(), name, present: db != null }); // [LOCK-DIAG]
    if (db == null) return this.#closing.get(name) ?? Promise.resolve();
    this.#dbs.delete(name);

    // Serialise behind any earlier close of the same database.
    const previousClose = this.#closing.get(name) ?? Promise.resolve();
    const closing: Promise<void> = previousClose
      .then(() => db.close())
      .finally(() => {
        if (this.#closing.get(name) === closing) this.#closing.delete(name);
        console.warn('[LOCK-DIAG] Dbs.close DONE', { t: Date.now(), name }); // [LOCK-DIAG]
      });
    this.#closing.set(name, closing);
    return closing;
  }
}

export const dbs = new Dbs();
