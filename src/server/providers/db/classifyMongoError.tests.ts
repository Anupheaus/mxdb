import { describe, it, expect } from 'vitest';
import { classifyMongoError, classifyMongoFailure } from './classifyMongoError';

describe('classifyMongoError', () => {
  it.each([
    ['duplicate key', 11_000],
    ['NamespaceNotFound', 26],
    ['WriteConflict', 112],
    ['NotWritablePrimary (election)', 10_107],
    ['NetworkTimeout', 89],
  ])('treats %s as expected (warn)', (_name, code) => {
    expect(classifyMongoError(code)).toBe('warn');
  });

  it.each([
    ['an unrecognised code', 121],
    ['no code at all', undefined],
  ])('treats %s as an error', (_name, code) => {
    expect(classifyMongoError(code)).toBe('error');
  });
});

describe('classifyMongoFailure', () => {
  it('is an error for a non-retryable failure', () => {
    expect(classifyMongoFailure({ code: 2, name: 'MongoServerError' })).toBe('error');
  });

  it('is an error when there is no failure to read', () => {
    expect(classifyMongoFailure(undefined)).toBe('error');
  });

  it('is a warn for a code-less network error', () => {
    expect(classifyMongoFailure({ name: 'MongoNetworkError' })).toBe('warn');
  });

  it.each(['TransientTransactionError', 'RetryableWriteError'])('is a warn when the driver labels it %s', label => {
    expect(classifyMongoFailure({ code: 2, errorLabels: [label] })).toBe('warn');
  });

  it('is a warn when the client was closed during shutdown', () => {
    expect(classifyMongoFailure({ name: 'MongoClientClosedError' })).toBe('warn');
  });
});
