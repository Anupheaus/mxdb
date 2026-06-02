type SqlClass = { isMutating: boolean; firstKeyword: string };

function stripLeadingCommentsAndWhitespace(sql: string): string {
  let s = sql;
  while (true) {
    const trimmed = s.trimStart();
    if (trimmed.startsWith('--')) {
      const nl = trimmed.indexOf('\n');
      s = nl === -1 ? '' : trimmed.slice(nl + 1);
      continue;
    }
    if (trimmed.startsWith('/*')) {
      const end = trimmed.indexOf('*/');
      s = end === -1 ? '' : trimmed.slice(end + 2);
      continue;
    }
    return trimmed;
  }
}

function readFirstKeyword(sql: string): { keyword: string; rest: string } {
  const cleaned = stripLeadingCommentsAndWhitespace(sql);
  const m = /^[A-Za-z]+/.exec(cleaned);
  if (!m) return { keyword: '', rest: cleaned };
  return { keyword: m[0]!.toUpperCase(), rest: cleaned.slice(m[0]!.length) };
}

/**
 * Best-effort SQL classifier to decide whether a statement is safe to execute
 * without user consent. This is intentionally conservative.
 */
export function classifyClientSql(sql: string): SqlClass {
  const { keyword: firstKeyword, rest } = readFirstKeyword(sql);

  if (firstKeyword === 'SELECT' || firstKeyword === 'WITH') {
    return { isMutating: false, firstKeyword };
  }

  // EXPLAIN is treated as read-only only when explaining a read-only statement.
  if (firstKeyword === 'EXPLAIN') {
    const { keyword: nextKeyword } = readFirstKeyword(rest);
    if (nextKeyword === 'SELECT' || nextKeyword === 'WITH') {
      return { isMutating: false, firstKeyword };
    }
  }

  // Everything else is considered mutating or potentially unsafe.
  return { isMutating: true, firstKeyword };
}

