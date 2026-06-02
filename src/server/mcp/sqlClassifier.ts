export type SqlClassification = { isMutating: boolean; firstKeyword: string };

function isWhitespace(ch: string): boolean {
  // Covers ASCII whitespace + common unicode whitespace via JS definition.
  return ch.trim().length === 0;
}

function stripLeadingWhitespaceAndComments(sql: string): string {
  let i = 0;

  while (i < sql.length) {
    // Skip whitespace
    while (i < sql.length && isWhitespace(sql[i]!)) i++;
    if (i >= sql.length) break;

    // Skip leading single-line comment: -- ... \n
    if (sql[i] === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }

    // Skip leading block comment: /* ... */
    if (sql[i] === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) {
        // Unterminated comment: treat remainder as comment (no keyword).
        return '';
      }
      i = end + 2;
      continue;
    }

    break;
  }

  return sql.slice(i);
}

function readFirstKeyword(cleanedSql: string): string {
  if (!cleanedSql) return '';
  const m = /^[A-Za-z]+/.exec(cleanedSql);
  return (m?.[0] ?? '').toUpperCase();
}

/**
 * Best-effort, deterministic SQL classifier.
 *
 * - Determines first keyword after leading whitespace/comments
 * - Treats only SELECT/WITH as read-only
 * - Everything else (including empty/whitespace-only) is treated as mutating for safety
 */
export function classifySql(sql: string): SqlClassification {
  const cleaned = stripLeadingWhitespaceAndComments(sql ?? '');
  const firstKeyword = readFirstKeyword(cleaned);
  const isMutating = firstKeyword !== 'SELECT' && firstKeyword !== 'WITH';
  return { isMutating, firstKeyword };
}

