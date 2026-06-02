import { compileIpAllowlist } from './ipAllowlist';

export type McpAuthInput = {
  ip: string | undefined;
  authorizationHeader: string | undefined;
  expectedApiKey: string | undefined;
  ipAllowlist: string | undefined;
};

export type McpAuthResult = { ok: true } | { ok: false; status: 401 | 403; error: string };

function parseBearerToken(authorizationHeader: string | undefined): string | undefined {
  const raw = (authorizationHeader ?? '').trim();
  if (!raw) return undefined;

  const space = raw.indexOf(' ');
  if (space === -1) return undefined;

  const scheme = raw.slice(0, space).trim();
  const token = raw.slice(space + 1).trim();
  if (!scheme || !token) return undefined;
  if (scheme.toLowerCase() !== 'bearer') return undefined;

  // Require exactly two parts (no extra whitespace-separated segments)
  if (token.includes(' ')) return undefined;

  return token;
}

export function isMcpAuthorized(input: McpAuthInput): McpAuthResult {
  const expectedApiKey = (input.expectedApiKey ?? '').trim();
  if (!expectedApiKey) return { ok: false, status: 401, error: 'missing_api_key' };

  const token = parseBearerToken(input.authorizationHeader);
  if (!token || token !== expectedApiKey) return { ok: false, status: 401, error: 'invalid_api_key' };

  const allowlistRaw = (input.ipAllowlist ?? '').trim();
  if (!allowlistRaw) return { ok: false, status: 403, error: 'ip_not_allowed' };

  const ip = (input.ip ?? '').trim();
  if (!ip) return { ok: false, status: 403, error: 'ip_not_allowed' };

  const isAllowed = compileIpAllowlist(allowlistRaw);
  if (!isAllowed(ip)) return { ok: false, status: 403, error: 'ip_not_allowed' };

  return { ok: true };
}

