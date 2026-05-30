export const SESSION_COOKIE_NAMES = ['nexus_session', 'socketapi_session'] as const;

export interface SessionHandshakeInput {
  cookieHeader?: string;
  sessionTokenFromAuth?: string;
}

/** Reads session token from Nexus/socket-api cookies, then handshake auth. */
export function parseSessionTokenFromHandshake(input: SessionHandshakeInput): string | undefined {
  const { cookieHeader, sessionTokenFromAuth } = input;
  if (cookieHeader != null) {
    for (const cookieName of SESSION_COOKIE_NAMES) {
      const prefix = `${cookieName}=`;
      const fromCookie = cookieHeader
        .split(';')
        .map(segment => segment.trim())
        .find(segment => segment.startsWith(prefix))
        ?.slice(prefix.length);
      if (fromCookie != null) return fromCookie;
    }
  }
  return sessionTokenFromAuth;
}
