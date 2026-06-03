import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSocket = vi.fn();
const mockCreateSubLogger = vi.fn();
const mockLoggerInstance = {
  createSubLogger: mockCreateSubLogger,
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  silly: vi.fn(),
};
mockCreateSubLogger.mockReturnValue(mockLoggerInstance);

vi.mock('@anupheaus/common', async importOriginal => {
  const actual = await importOriginal() as object;
  return {
    ...actual,
    Logger: Object.assign(
      class MockLogger {
        static getCurrent() { return mockLoggerInstance; }
        createSubLogger() { return mockLoggerInstance; }
      },
      actual['Logger' as keyof typeof actual],
    ),
  };
});

vi.mock('@anupheaus/nexus/server', () => ({
  useClient: () => mockSocket(),
}));

vi.mock('../subscriptionDataStore', () => ({
  subscriptionDataGet: vi.fn(),
  subscriptionDataIsAvailable: vi.fn(),
  subscriptionDataSet: vi.fn(),
}));

import { useClient } from './useClient';
import {
  subscriptionDataGet,
  subscriptionDataIsAvailable,
  subscriptionDataSet,
} from '../subscriptionDataStore';

describe('useClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket.mockReturnValue({ id: 'socket-1' });
  });

  // ─── Subscription data references ───────────────────────────────────────────

  it('exposes getData pointing to subscriptionDataGet', () => {
    const result = useClient();
    expect(result.getData).toBe(subscriptionDataGet);
  });

  it('exposes setData pointing to subscriptionDataSet', () => {
    const result = useClient();
    expect(result.setData).toBe(subscriptionDataSet);
  });

  it('exposes isDataAvailable pointing to subscriptionDataIsAvailable', () => {
    const result = useClient();
    expect(result.isDataAvailable).toBe(subscriptionDataIsAvailable);
  });

  // ─── getLogger ────────────────────────────────────────────────────────────────

  it('getLogger returns a logger when socket exists', () => {
    mockSocket.mockReturnValue({ id: 'socket-1' });
    const result = useClient();
    expect(() => result.getLogger()).not.toThrow();
  });

  it('getLogger returns a logger when socket is null', () => {
    mockSocket.mockReturnValue(null);
    const result = useClient();
    expect(() => result.getLogger()).not.toThrow();
  });

  it('getLogger accepts a subLoggerName', () => {
    const result = useClient();
    expect(() => result.getLogger('sub')).not.toThrow();
  });
});
