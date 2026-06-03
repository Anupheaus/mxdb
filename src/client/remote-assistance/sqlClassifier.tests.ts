import { describe, it, expect } from 'vitest';
import { classifyClientSql } from './sqlClassifier';

describe('classifyClientSql', () => {
  // ─── Read-only statements ──────────────────────────────────────────────────

  it('treats SELECT as read-only', () => {
    expect(classifyClientSql('SELECT * FROM t')).toEqual({ isMutating: false, firstKeyword: 'SELECT' });
  });

  it('treats lowercase select as read-only', () => {
    expect(classifyClientSql('select 1')).toEqual({ isMutating: false, firstKeyword: 'SELECT' });
  });

  it('treats WITH as read-only', () => {
    expect(classifyClientSql('WITH cte AS (SELECT 1) SELECT * FROM cte')).toEqual({
      isMutating: false,
      firstKeyword: 'WITH',
    });
  });

  it('treats EXPLAIN SELECT as read-only', () => {
    expect(classifyClientSql('EXPLAIN SELECT * FROM t')).toEqual({
      isMutating: false,
      firstKeyword: 'EXPLAIN',
    });
  });

  it('treats EXPLAIN WITH as read-only', () => {
    expect(classifyClientSql('EXPLAIN WITH cte AS (SELECT 1) SELECT * FROM cte')).toEqual({
      isMutating: false,
      firstKeyword: 'EXPLAIN',
    });
  });

  // ─── Mutating statements ───────────────────────────────────────────────────

  it('treats INSERT as mutating', () => {
    expect(classifyClientSql('INSERT INTO t VALUES (1)')).toEqual({
      isMutating: true,
      firstKeyword: 'INSERT',
    });
  });

  it('treats UPDATE as mutating', () => {
    expect(classifyClientSql('UPDATE t SET x=1')).toEqual({ isMutating: true, firstKeyword: 'UPDATE' });
  });

  it('treats DELETE as mutating', () => {
    expect(classifyClientSql('DELETE FROM t')).toEqual({ isMutating: true, firstKeyword: 'DELETE' });
  });

  it('treats DROP as mutating', () => {
    expect(classifyClientSql('DROP TABLE t')).toEqual({ isMutating: true, firstKeyword: 'DROP' });
  });

  it('treats CREATE as mutating', () => {
    expect(classifyClientSql('CREATE TABLE t (id TEXT)')).toEqual({
      isMutating: true,
      firstKeyword: 'CREATE',
    });
  });

  it('treats ALTER as mutating', () => {
    expect(classifyClientSql('ALTER TABLE t ADD COLUMN x INT')).toEqual({
      isMutating: true,
      firstKeyword: 'ALTER',
    });
  });

  it('treats PRAGMA as mutating', () => {
    expect(classifyClientSql('PRAGMA journal_mode=WAL')).toEqual({
      isMutating: true,
      firstKeyword: 'PRAGMA',
    });
  });

  it('treats EXPLAIN INSERT as mutating', () => {
    expect(classifyClientSql('EXPLAIN INSERT INTO t VALUES (1)')).toEqual({
      isMutating: true,
      firstKeyword: 'EXPLAIN',
    });
  });

  // ─── Comment and whitespace stripping ─────────────────────────────────────

  it('ignores leading whitespace', () => {
    expect(classifyClientSql('   \n\t  SELECT 1')).toEqual({
      isMutating: false,
      firstKeyword: 'SELECT',
    });
  });

  it('ignores leading -- line comments', () => {
    expect(classifyClientSql('-- comment\nSELECT 1')).toEqual({
      isMutating: false,
      firstKeyword: 'SELECT',
    });
  });

  it('ignores multiple leading -- line comments', () => {
    expect(classifyClientSql('-- first\n-- second\nSELECT 1')).toEqual({
      isMutating: false,
      firstKeyword: 'SELECT',
    });
  });

  it('ignores leading /* */ block comments', () => {
    expect(classifyClientSql('/* block comment */ SELECT 1')).toEqual({
      isMutating: false,
      firstKeyword: 'SELECT',
    });
  });

  it('ignores multiline /* */ block comments', () => {
    expect(classifyClientSql('/* multi\nline\ncomment */\nSELECT 1')).toEqual({
      isMutating: false,
      firstKeyword: 'SELECT',
    });
  });

  it('strips a mix of leading comments and whitespace', () => {
    expect(classifyClientSql('  -- comment\n  /* block */ INSERT INTO t VALUES (1)')).toEqual({
      isMutating: true,
      firstKeyword: 'INSERT',
    });
  });

  // ─── Empty / blank input ──────────────────────────────────────────────────

  it('treats empty string as mutating with empty firstKeyword', () => {
    expect(classifyClientSql('')).toEqual({ isMutating: true, firstKeyword: '' });
  });

  it('treats whitespace-only string as mutating with empty firstKeyword', () => {
    expect(classifyClientSql('   \n\t  ')).toEqual({ isMutating: true, firstKeyword: '' });
  });
});
