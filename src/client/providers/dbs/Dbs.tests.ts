import { describe, it, expect, vi, beforeEach } from 'vitest';

// A controllable Db stand-in: records its constructor args and lets each test decide when close() settles.
const { createdDbs } = vi.hoisted(() => ({ createdDbs: [] as any[] }));

vi.mock('./Db', () => ({
  Db: class {
    name: string;
    afterPreviousClose: Promise<void> | undefined;
    releaseClose!: () => void;
    // Created up front so a test can release it before Dbs has (asynchronously) called close().
    closed = new Promise<void>(resolve => { this.releaseClose = resolve; });
    close = vi.fn(() => this.closed);
    constructor(name: string, _collections: unknown, _key: unknown, _logger: unknown, afterPreviousClose?: Promise<void>) {
      this.name = name;
      this.afterPreviousClose = afterPreviousClose;
      createdDbs.push(this);
    }
  },
}));

const { dbs } = await import('./Dbs');

describe('Dbs close → open (DbsProvider re-run without awaiting close)', () => {
  beforeEach(async () => {
    // Drain anything a previous test left open.
    const closing = dbs.close('app');
    createdDbs.forEach(db => db.releaseClose?.());
    await closing;
    createdDbs.length = 0;
  });

  it('opens a FRESH Db rather than handing back the one that is closing', async () => {
    const first = dbs.open('app', []);
    const closing = dbs.close('app');
    const second = dbs.open('app', []);

    expect(second).not.toBe(first);
    (first as any).releaseClose();
    await closing;
    expect(first.close).toHaveBeenCalledOnce();
  });

  it('makes the fresh Db wait for the previous close before it opens the file', async () => {
    dbs.open('app', []);
    void dbs.close('app');
    const second = dbs.open('app', []) as any;

    let hasPreviousCloseSettled = false;
    const waited = second.afterPreviousClose.then(() => { hasPreviousCloseSettled = true; });
    await Promise.resolve();
    expect(hasPreviousCloseSettled).toBe(false);

    createdDbs[0].releaseClose();
    await waited;
    expect(hasPreviousCloseSettled).toBe(true);
  });

  it('a finished close never removes a Db opened after it began', async () => {
    dbs.open('app', []);
    const closing = dbs.close('app');
    const second = dbs.open('app', []);

    createdDbs[0].releaseClose();
    await closing;

    expect(dbs.open('app', [])).toBe(second);
  });

  it('reuses the open Db when nothing is closing', () => {
    const first = dbs.open('app', []);
    expect(dbs.open('app', [])).toBe(first);
  });
});
