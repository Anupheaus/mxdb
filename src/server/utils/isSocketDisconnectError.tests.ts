import { describe, it, expect } from 'vitest';
import { isSocketDisconnectError } from './isSocketDisconnectError';

describe('isSocketDisconnectError', () => {
  const disconnectErrors: unknown[] = [
    new Error('socket has been disconnected'),
    new Error('transport close'),
    new Error('Socket has been disconnected'),
    new Error('TRANSPORT CLOSE'),
    new Error('emit failed: socket has been disconnected by server'),
    { message: 'socket has been disconnected' },
    'transport close',
  ];

  it.each(disconnectErrors)('returns true for the socket disconnect %p', error => {
    expect(isSocketDisconnectError(error)).toBe(true);
  });

  const otherErrors: unknown[] = [
    new Error('emit exploded'),
    new Error('socket has been connected'),
    new Error('transport opened'),
    new Error(''),
    { message: 42 },
    {},
    'plain string reason',
    '',
    42,
    null,
    undefined,
  ];

  it.each(otherErrors)('returns false for %p', error => {
    expect(isSocketDisconnectError(error)).toBe(false);
  });
});
