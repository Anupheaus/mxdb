// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MXDBError } from '../../../common';

// DbsProvider decides what the app is told when its database cannot be opened. The Db itself (and its SQLite worker)
// is replaced by a stand-in whose open the test settles.

const harness = vi.hoisted(() => ({
  opened: [] as Array<{ name: string; settleOpen(error?: Error): void }>,
}));

vi.mock('./Dbs', () => ({
  dbs: {
    close: vi.fn(),
    open: (name: string) => {
      let settleOpen!: (error?: Error) => void;
      const opening = new Promise<void>((resolve, reject) => { settleOpen = error => (error == null ? resolve() : reject(error)); });
      harness.opened.push({ name, settleOpen });
      return { name, whenOpen: () => opening, use: vi.fn() };
    },
  },
}));

vi.mock('@anupheaus/react-ui', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createComponent: (_name: string, component: unknown) => component,
}));

const { DbsProvider } = await import('./DbsProvider');

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = new Uint8Array(32).fill(1);
const OTHER_KEY = new Uint8Array(32).fill(2);

let root: Root;

async function render(props: { encryptionKey: Uint8Array; onError(error: MXDBError): void }): Promise<void> {
  await act(async () => { root.render(<DbsProvider name="user-1" collections={[]} {...props} />); });
}

beforeEach(() => {
  harness.opened.length = 0;
  vi.spyOn(console, 'warn').mockImplementation(() => { /* lock diagnostics */ });
  root = createRoot(document.createElement('div'));
});

afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
});

describe('DbsProvider when the database cannot be opened', () => {
  it('tells the app, as a fatal DB_NOT_OPEN carrying the reason', async () => {
    const onError = vi.fn();
    await render({ encryptionKey: KEY, onError });
    const reason = new Error('The device\'s local database did not start: its SQLite SharedWorker did not answer.');

    await act(async () => harness.opened[0]!.settleOpen(reason));

    expect(onError.mock.calls).toEqual([[{ code: 'DB_NOT_OPEN', severity: 'fatal', message: reason.message, originalError: reason }]]);
  });

  it('says nothing when the database opens', async () => {
    const onError = vi.fn();
    await render({ encryptionKey: KEY, onError });

    await act(async () => harness.opened[0]!.settleOpen());

    expect(onError).not.toHaveBeenCalled();
  });

  it('says nothing about a database that was replaced before its open failed', async () => {
    const onError = vi.fn();
    await render({ encryptionKey: KEY, onError });
    await render({ encryptionKey: OTHER_KEY, onError });

    await act(async () => harness.opened[0]!.settleOpen(new Error('closed for the new key')));

    expect([harness.opened.length, onError.mock.calls.length]).toEqual([2, 0]);
  });
});
