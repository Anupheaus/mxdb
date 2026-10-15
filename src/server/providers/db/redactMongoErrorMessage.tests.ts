import { describe, it, expect } from 'vitest';
import { redactMongoErrorMessage } from './redactMongoErrorMessage';

describe('redactMongoErrorMessage', () => {
  it('removes the values a duplicate-key message quotes', () => {
    const message = 'E11000 duplicate key error collection: app.users index: email_1 dup key: { email: "jane@example.com" }';
    const result = redactMongoErrorMessage(message);
    expect(result).not.toContain('jane@example.com');
    expect(result).toContain('E11000 duplicate key error collection: app.users index: email_1');
  });

  it('leaves a message without values alone', () => {
    expect(redactMongoErrorMessage('connection refused')).toBe('connection refused');
  });
});
