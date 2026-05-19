import { describe, it, expect } from 'vitest';
import { isTransientMongoCloseError } from './isTransientMongoCloseError';

describe('isTransientMongoCloseError', () => {
  // ─── Named error classes that are always transient ────────────────────────

  const transientNames = [
    'MongoClientClosedError',
    'MongoPoolClosedError',
    'PoolClosedError',
    'MongoExpiredSessionError',
    'MongoNotConnectedError',
  ];

  it.each(transientNames)('returns true for error name "%s"', name => {
    expect(isTransientMongoCloseError({ name })).toBe(true);
  });

  // ─── Regex-matched message patterns ──────────────────────────────────────

  const transientMessages = [
    'client was closed',
    'closed connection pool',
    'session that has ended',
    'Client must be connected',
  ];

  it.each(transientMessages)('returns true for message "%s"', message => {
    expect(isTransientMongoCloseError({ name: 'MongoError', message })).toBe(true);
  });

  // ─── Non-transient named errors ───────────────────────────────────────────

  const nonTransientNames = ['MongoError', 'Error', 'MongoNetworkError', 'MongoWriteConcernError'];

  it.each(nonTransientNames)('returns false for non-transient error name "%s"', name => {
    expect(isTransientMongoCloseError({ name, message: '' })).toBe(false);
  });

  // ─── Non-transient messages ───────────────────────────────────────────────

  const nonTransientMessages = ['network timeout', 'authentication failed', 'ETIMEDOUT', ''];

  it.each(nonTransientMessages)('returns false for non-transient message "%s"', message => {
    expect(isTransientMongoCloseError({ name: 'MongoError', message })).toBe(false);
  });

  // ─── Null / undefined / non-object values ─────────────────────────────────

  const falsy = [null, undefined, 0, false, 'MongoClientClosedError', 42];

  it.each(falsy)('returns false for non-object value %p', value => {
    expect(isTransientMongoCloseError(value)).toBe(false);
  });

  // ─── Object with no name or message ──────────────────────────────────────

  it('returns false for an object with no name or message', () => {
    expect(isTransientMongoCloseError({})).toBe(false);
  });
});
