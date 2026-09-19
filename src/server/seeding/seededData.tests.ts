import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock the 'fs' module before importing the module under test ───────────────

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();

vi.mock('fs', () => {
  const impl = {
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  };
  return { ...impl, default: impl };
});

import { loadSeededData, saveSeededData } from './seededData';

// ─── Test setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── loadSeededData ───────────────────────────────────────────────────────────

describe('loadSeededData', () => {
  it('returns an empty object when the file does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    const result = loadSeededData();
    expect(result).toEqual({});
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it('returns parsed JSON when the file exists with valid content', () => {
    const data = { users: 'abc123', products: 'def456' };
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(data));
    const result = loadSeededData();
    expect(result).toEqual(data);
  });

  it('returns an empty object when the file exists but contains invalid JSON', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not-valid-json {{');
    const result = loadSeededData();
    expect(result).toEqual({});
  });

  it('returns an empty object when readFileSync throws', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => { throw new Error('permission denied'); });
    const result = loadSeededData();
    expect(result).toEqual({});
  });

  it('returns an empty object for an empty file (empty string)', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('');
    const result = loadSeededData();
    expect(result).toEqual({});
  });

  it('reads from the seededData.json path in the current working directory', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{}');
    loadSeededData();
    const calledPath = mockReadFileSync.mock.calls[0]![0] as string;
    expect(calledPath).toContain('seededData.json');
  });
});

// ─── saveSeededData ───────────────────────────────────────────────────────────

describe('saveSeededData', () => {
  it('writes JSON to the seededData.json file', () => {
    const data = { users: 'hash1' };
    saveSeededData(data);
    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    const [filePath, content] = mockWriteFileSync.mock.calls[0] as [string, string, string];
    expect(filePath).toContain('seededData.json');
    expect(JSON.parse(content)).toEqual(data);
  });

  it('writes pretty-printed JSON (2-space indent)', () => {
    const data = { users: 'hash1' };
    saveSeededData(data);
    const content = mockWriteFileSync.mock.calls[0]![1] as string;
    expect(content).toBe(JSON.stringify(data, null, 2));
  });

  it('writes with utf8 encoding', () => {
    saveSeededData({});
    const encoding = mockWriteFileSync.mock.calls[0]![2] as string;
    expect(encoding).toBe('utf8');
  });

  it('writes an empty object as {}', () => {
    saveSeededData({});
    const content = mockWriteFileSync.mock.calls[0]![1] as string;
    expect(JSON.parse(content)).toEqual({});
  });

  it('round-trips save → load correctly', () => {
    const data = { addresses: 'aaa', products: 'bbb' };

    // Capture what was written
    let written = '';
    mockWriteFileSync.mockImplementation((_path: string, content: string) => { written = content; });
    saveSeededData(data);

    // Feed the written content back to loadSeededData
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(written);
    const loaded = loadSeededData();
    expect(loaded).toEqual(data);
  });

  it('handles collections with special characters in names', () => {
    const data = { 'my-collection_v2': 'hashXYZ' };
    saveSeededData(data);
    const content = mockWriteFileSync.mock.calls[0]![1] as string;
    expect(JSON.parse(content)).toEqual(data);
  });
});
