import { describe, expect, it, vi } from 'vitest';
import { createMutatingConsentGate } from './consentGate';

describe('createMutatingConsentGate', () => {
  it('returns false on first call when callback is missing', async () => {
    const gate = createMutatingConsentGate(undefined);
    await expect(gate({ sql: 'UPDATE t SET a=1', requestedBy: 'mcp' })).resolves.toBe(false);
  });

  it('asks once and memoizes true', async () => {
    const onRequest = vi.fn().mockResolvedValue(true);
    const gate = createMutatingConsentGate(onRequest);

    await expect(gate({ sql: 'UPDATE t SET a=1', requestedBy: 'mcp' })).resolves.toBe(true);
    await expect(gate({ sql: 'DELETE FROM t', requestedBy: 'mcp' })).resolves.toBe(true);

    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(onRequest).toHaveBeenCalledWith({ sql: 'UPDATE t SET a=1', requestedBy: 'mcp' });
  });

  it('asks once and memoizes false', async () => {
    const onRequest = vi.fn().mockResolvedValue(false);
    const gate = createMutatingConsentGate(onRequest);

    await expect(gate({ sql: 'UPDATE t SET a=1', requestedBy: 'mcp' })).resolves.toBe(false);
    await expect(gate({ sql: 'DELETE FROM t', requestedBy: 'mcp' })).resolves.toBe(false);

    expect(onRequest).toHaveBeenCalledTimes(1);
  });
});

