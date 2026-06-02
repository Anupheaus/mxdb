import { describe, expect, it } from 'vitest';
import { isMcpAuthorized } from './mcpAuth';

describe('isMcpAuthorized', () => {
  it('rejects when expected api key is missing/empty', () => {
    expect(
      isMcpAuthorized({
        ip: '1.2.3.4',
        authorizationHeader: 'Bearer abc',
        expectedApiKey: undefined,
        ipAllowlist: '1.2.3.4',
      }),
    ).toEqual({ ok: false, status: 401, error: 'missing_api_key' });

    expect(
      isMcpAuthorized({
        ip: '1.2.3.4',
        authorizationHeader: 'Bearer abc',
        expectedApiKey: '   ',
        ipAllowlist: '1.2.3.4',
      }),
    ).toEqual({ ok: false, status: 401, error: 'missing_api_key' });
  });

  it('rejects when auth header is missing', () => {
    expect(
      isMcpAuthorized({
        ip: '1.2.3.4',
        authorizationHeader: undefined,
        expectedApiKey: 'abc',
        ipAllowlist: '1.2.3.4',
      }),
    ).toEqual({ ok: false, status: 401, error: 'invalid_api_key' });
  });

  it('rejects when bearer scheme/token is wrong', () => {
    expect(
      isMcpAuthorized({
        ip: '1.2.3.4',
        authorizationHeader: 'Basic abc',
        expectedApiKey: 'abc',
        ipAllowlist: '1.2.3.4',
      }),
    ).toEqual({ ok: false, status: 401, error: 'invalid_api_key' });

    expect(
      isMcpAuthorized({
        ip: '1.2.3.4',
        authorizationHeader: 'Bearer wrong',
        expectedApiKey: 'abc',
        ipAllowlist: '1.2.3.4',
      }),
    ).toEqual({ ok: false, status: 401, error: 'invalid_api_key' });

    expect(
      isMcpAuthorized({
        ip: '1.2.3.4',
        authorizationHeader: 'Bearer abc extra',
        expectedApiKey: 'abc',
        ipAllowlist: '1.2.3.4',
      }),
    ).toEqual({ ok: false, status: 401, error: 'invalid_api_key' });

    expect(
      isMcpAuthorized({
        ip: '1.2.3.4',
        authorizationHeader: 'bearer abc',
        expectedApiKey: 'abc',
        ipAllowlist: '1.2.3.4',
      }),
    ).toEqual({ ok: true });
  });

  it('rejects when allowlist is missing/empty', () => {
    expect(
      isMcpAuthorized({
        ip: '1.2.3.4',
        authorizationHeader: 'Bearer abc',
        expectedApiKey: 'abc',
        ipAllowlist: undefined,
      }),
    ).toEqual({ ok: false, status: 403, error: 'ip_not_allowed' });

    expect(
      isMcpAuthorized({
        ip: '1.2.3.4',
        authorizationHeader: 'Bearer abc',
        expectedApiKey: 'abc',
        ipAllowlist: '   ',
      }),
    ).toEqual({ ok: false, status: 403, error: 'ip_not_allowed' });
  });

  it('rejects when ip is missing', () => {
    expect(
      isMcpAuthorized({
        ip: undefined,
        authorizationHeader: 'Bearer abc',
        expectedApiKey: 'abc',
        ipAllowlist: '1.2.3.4',
      }),
    ).toEqual({ ok: false, status: 403, error: 'ip_not_allowed' });
  });

  it('rejects when ip is not allowed', () => {
    expect(
      isMcpAuthorized({
        ip: '1.2.3.5',
        authorizationHeader: 'Bearer abc',
        expectedApiKey: 'abc',
        ipAllowlist: '1.2.3.4',
      }),
    ).toEqual({ ok: false, status: 403, error: 'ip_not_allowed' });
  });

  it('accepts happy path', () => {
    expect(
      isMcpAuthorized({
        ip: '1.2.3.4',
        authorizationHeader: 'Bearer abc',
        expectedApiKey: 'abc',
        ipAllowlist: '1.2.3.4,10.0.0.0/24',
      }),
    ).toEqual({ ok: true });
  });
});

