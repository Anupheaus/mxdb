import { describe, expect, it } from 'vitest';
import { classifySql } from './sqlClassifier';

describe('classifySql', () => {
  it('treats SELECT as read-only', () => {
    expect(classifySql('select 1')).toEqual({ isMutating: false, firstKeyword: 'SELECT' });
  });

  it('treats WITH as read-only', () => {
    expect(classifySql('with cte as (select 1) select * from cte')).toEqual({
      isMutating: false,
      firstKeyword: 'WITH',
    });
  });

  it('treats UPDATE as mutating', () => {
    expect(classifySql('update t set x=1')).toEqual({ isMutating: true, firstKeyword: 'UPDATE' });
  });

  it('ignores leading whitespace', () => {
    expect(classifySql('   \n\t  select 1')).toEqual({ isMutating: false, firstKeyword: 'SELECT' });
  });

  it('ignores leading -- comments', () => {
    expect(classifySql('-- hello\nselect 1')).toEqual({ isMutating: false, firstKeyword: 'SELECT' });
    expect(classifySql('  -- hello\r\n  -- second\n  select 1')).toEqual({
      isMutating: false,
      firstKeyword: 'SELECT',
    });
  });

  it('ignores leading /* */ block comments', () => {
    expect(classifySql('/* hi */select 1')).toEqual({ isMutating: false, firstKeyword: 'SELECT' });
    expect(classifySql('  /* multi\nline */  select 1')).toEqual({
      isMutating: false,
      firstKeyword: 'SELECT',
    });
  });

  it('treats empty string as mutating', () => {
    expect(classifySql('')).toEqual({ isMutating: true, firstKeyword: '' });
    expect(classifySql('   \n\t ')).toEqual({ isMutating: true, firstKeyword: '' });
  });
});

