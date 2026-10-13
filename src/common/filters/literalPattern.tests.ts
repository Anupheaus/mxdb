import { describe, it, expect } from 'vitest';
import { parseLiteralPattern, toCanonicalPattern } from './literalPattern';

// Vision sc-2518 QA round 5: `$regex` is limited to literal patterns, the one shape JavaScript and MongoDB's PCRE read
// alike, tested here without a backtracking engine.

describe('parseLiteralPattern', () => {
  it.each([
    ['contains', 'ot', 'Foxtrot', true], ['contains, missing', 'xy', 'Foxtrot', false],
    ['^ anchors at the start', '^Fo', 'Foxtrot', true], ['^ is not "contains"', '^ot', 'Foxtrot', false],
    ['$ anchors at the end', 'ot$', 'Foxtrot', true], ['$ also before a final newline, as PCRE reads it', 'ot$', 'Foxtrot\n', true],
    ['$ not before an inner newline', 'ot$', 'Foxtrot\nx', false], ['^…$ is the whole text', '^Fox$', 'Fox', true],
    ['^…$ with a final newline', '^Fox$', 'Fox\n', true], ['^…$ is not a prefix', '^Fox$', 'Foxtrot', false],
    ['an escaped metacharacter is literal', 'a\\.b', 'a.b', true], ['an escaped metacharacter is not a wildcard', 'a\\.b', 'axb', false],
    ['an empty pattern matches any text', '', '', true], ['non-ASCII text', '^É', 'Échelle', true],
  ])('%s', (_label, pattern, text, expected) => {
    expect(parseLiteralPattern(pattern)!.test(text)).toBe(expected);
  });

  it.each([
    ['[[:alpha:]]'], ['\\p{L}'], ['\\AO'], ['e\\Z'], ['^(a+)+$'], ['a|b'], ['(?i)a'], ['a.c'], ['ab*'], ['a+'], ['a?'], ['a{2}'],
    ['\\d'], ['\\w'], ['\\'], ['a^b'], ['a$b'], ['a\nb'], ['a b'], ['a\ud800b'], ['a'.repeat(129)],
  ])('refuses %s', pattern => {
    expect(parseLiteralPattern(pattern)).toBeUndefined();
  });

  it('accepts a pattern at the length cap', () => {
    expect(parseLiteralPattern('a'.repeat(128))).toBeDefined();
  });

  it('tests a long text in linear time', () => {
    const pattern = parseLiteralPattern(`^${'a'.repeat(100)}$`)!;
    const started = performance.now();
    expect(pattern.test(`${'a'.repeat(1_000_000)}!`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe('toCanonicalPattern', () => {
  it.each([
    ['^a\\/b\\-c$', '^a/b-c$'], ['a\\.b', 'a\\.b'], ['\\$', '\\$'], ['\\^x', '\\^x'], ['', ''], ['^', '^'], ['$', '$'],
  ])('writes %s as %s, and its canonical form is stable', (pattern, canonical) => {
    expect(toCanonicalPattern(parseLiteralPattern(pattern)!)).toBe(canonical);
    expect(toCanonicalPattern(parseLiteralPattern(canonical)!)).toBe(canonical);
  });
});
