import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORKER_FILES } from './worker-files';

/**
 * The worker sources are shipped as a flat copy (see `worker-files.ts`), so each one may only import, by a relative
 * path, another file that is shipped with it. A missing entry broke every consumer build in mxdb 0.2.1.
 */

// Resolved from the repo root (where the test scripts run): CI runs the tests as ES modules, without `__dirname`.
const WORKER_DIR = join(process.cwd(), 'src', 'client', 'db-worker');

/** Every relative module a source file imports or re-exports, statically or dynamically (`./name`, no extension). */
function relativeImportsOf(source: string): string[] {
  const specifiers = [...source.matchAll(/(?:from\s+|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)].map(([, specifier]) => specifier!);
  return [...new Set(specifiers)];
}

describe('the shipped worker files', () => {
  it('all exist', () => {
    expect(WORKER_FILES.filter(file => !existsSync(join(WORKER_DIR, file)))).toEqual([]);
  });

  it.each(WORKER_FILES)('%s imports only other shipped worker files', file => {
    const imports = relativeImportsOf(readFileSync(join(WORKER_DIR, file), 'utf8'));
    const unshipped = imports.filter(specifier => !specifier.startsWith('./') || !WORKER_FILES.includes(`${specifier.slice(2)}.ts`));
    expect(unshipped).toEqual([]);
  });
});
