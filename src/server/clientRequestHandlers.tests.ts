import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Every client request reaches a collection through one of two factories, each of which refuses a request naming a
 * server-only collection before its handler runs (`refuseServerOnlyCollections`). A handler registered straight on
 * nexus would skip that check, so no other file in the client request folders may register one.
 */
const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_REQUEST_FOLDERS = ['actions', 'subscriptions'];
const GUARDED_FACTORIES = new Set([path.join('actions', 'createClientActionHandler.ts'), path.join('subscriptions', 'createServerCollectionSubscription.ts')]);
const NEXUS_REGISTRATION = /\bcreateServer(ActionHandler|Subscription)\s*\(/;

function sourceFilesIn(folder: string): string[] {
  return fs.readdirSync(path.join(SERVER_DIR, folder))
    .filter(fileName => fileName.endsWith('.ts') && !fileName.endsWith('.tests.ts'))
    .map(fileName => path.join(folder, fileName));
}

describe('client request handlers', () => {
  it('are all registered through a factory that refuses server-only collections', () => {
    const unguarded = CLIENT_REQUEST_FOLDERS.flatMap(sourceFilesIn)
      .filter(file => !GUARDED_FACTORIES.has(file))
      .filter(file => NEXUS_REGISTRATION.test(fs.readFileSync(path.join(SERVER_DIR, file), 'utf8')));
    expect(unguarded).toEqual([]);
  });
});
