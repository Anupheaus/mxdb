import { describe, it, expect } from 'vitest';
import { Db } from './Db';
import type { MXDBCollectionConfig } from '../../../common/models';

const configs: MXDBCollectionConfig[] = [
  { name: 'accounts', indexes: [] },
  { name: 'users', indexes: [] },
];

describe('Db.use error reporting', () => {
  it('throws an informative error naming the db, the missing collection and what IS registered', () => {
    const db = new Db('mobile-db', configs);

    let error: any;
    try {
      db.use('settings');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeDefined();
    // Message carries the requested name, the database name, and the registered collections.
    expect(error.message).toContain('"settings"');
    expect(error.message).toContain('mobile-db');
    expect(error.message).toContain('accounts');
    expect(error.message).toContain('users');
    // Structured meta for programmatic inspection / logging.
    expect(error.meta).toMatchObject({ database: 'mobile-db', requestedCollection: 'settings' });
    expect(error.meta.availableCollections).toEqual(['accounts', 'users']);
  });
});
