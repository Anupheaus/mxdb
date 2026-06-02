import { describe, it, expect } from 'vitest';
import { compileIpAllowlist } from './ipAllowlist';

describe('compileIpAllowlist', () => {
  it('matches exact IPv4 entry', () => {
    const match = compileIpAllowlist('1.2.3.4');
    expect(match('1.2.3.4')).toBe(true);
    expect(match('1.2.3.5')).toBe(false);
  });

  it('matches IPv4 CIDR entry', () => {
    const match = compileIpAllowlist('10.0.0.0/24');
    expect(match('10.0.0.1')).toBe(true);
    expect(match('10.0.1.1')).toBe(false);
  });

  it('handles comma-separated entries with spaces', () => {
    const match = compileIpAllowlist(' 1.2.3.4 , 10.0.0.0/24  ');
    expect(match('1.2.3.4')).toBe(true);
    expect(match('10.0.0.8')).toBe(true);
    expect(match('10.0.1.8')).toBe(false);
  });

  it('rejects when allowlist is empty/undefined', () => {
    expect(compileIpAllowlist(undefined)('1.2.3.4')).toBe(false);
    expect(compileIpAllowlist('')('1.2.3.4')).toBe(false);
    expect(compileIpAllowlist('   ')('1.2.3.4')).toBe(false);
  });

  it('rejects when ip is undefined/empty', () => {
    const match = compileIpAllowlist('1.2.3.4');
    expect(match(undefined)).toBe(false);
    expect(match('')).toBe(false);
    expect(match('   ')).toBe(false);
  });
});

