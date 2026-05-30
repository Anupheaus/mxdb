import { describe, it, expect } from 'vitest';
import { parseSessionTokenFromHandshake } from './parseSessionTokenFromHandshake';

describe('parseSessionTokenFromHandshake', () => {
  it('prefers nexus_session cookie over socketapi_session', () => {
    const token = parseSessionTokenFromHandshake({
      cookieHeader: 'socketapi_session=legacy; nexus_session=nexus-tok',
    });
    expect(token).toBe('nexus-tok');
  });

  it('reads socketapi_session when nexus_session is absent', () => {
    const token = parseSessionTokenFromHandshake({
      cookieHeader: 'other=value; socketapi_session=legacy-tok',
    });
    expect(token).toBe('legacy-tok');
  });

  it('falls back to handshake auth sessionToken when no cookie matches', () => {
    const token = parseSessionTokenFromHandshake({
      cookieHeader: 'unrelated=value',
      sessionTokenFromAuth: 'auth-tok',
    });
    expect(token).toBe('auth-tok');
  });

  it('returns undefined when no token is present', () => {
    expect(parseSessionTokenFromHandshake({})).toBeUndefined();
  });
});
