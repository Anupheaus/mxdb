// `$regex` patterns MXDB accepts: a literal text with optional anchors — the one shape JavaScript and MongoDB's PCRE
// read the same way, matched in linear time on the device (no backtracking engine, so no catastrophic patterns).
//
//   pattern := "^"? literal* "$"?          (at most MAX_PATTERN_LENGTH characters, no flags)
//   literal := any character except  \ ^ $ . | ? * + ( ) [ ] { }  and control characters
//            | "\" followed by one of  \ ^ $ . | ? * + ( ) [ ] { } / -
//
// "^" anchors at the start of the text. "$" anchors at the end, or just before a final newline, as PCRE reads it.
// A value that is not text never matches, so `$not` / `$nor` of a pattern match records whose field is missing,
// null, a number or any text the pattern does not match — the same rule on both engines.

/** The longest pattern accepted. */
const MAX_PATTERN_LENGTH = 128;

const METACHARACTERS = new Set(['\\', '^', '$', '.', '|', '?', '*', '+', '(', ')', '[', ']', '{', '}']);

/** Characters that may follow a backslash: each then stands for itself. */
const ESCAPABLE = new Set([...METACHARACTERS, '/', '-']);

/** The last C0 control code point; it and everything below it (line breaks included) is not accepted in a pattern. */
const LAST_C0_CONTROL = 0x1f;
/** DEL and the Unicode line and paragraph separators, also not accepted. */
const OTHER_REFUSED_CODE_POINTS = [0x7f, 0x2028, 0x2029];

/** A lone UTF-16 surrogate has no UTF-8 form, so MongoDB could not receive the same text the device tests. */
const SURROGATES = { first: 0xd800, last: 0xdfff };

function isRefusedCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0)!;
  const isLoneSurrogate = codePoint >= SURROGATES.first && codePoint <= SURROGATES.last;
  return codePoint <= LAST_C0_CONTROL || isLoneSurrogate || OTHER_REFUSED_CODE_POINTS.includes(codePoint);
}

const NEWLINE = '\n';

/** A parsed pattern: its literal text and anchors, and a linear-time test. */
export interface LiteralPattern {
  literal: string;
  isAnchoredAtStart: boolean;
  isAnchoredAtEnd: boolean;
  test(text: string): boolean;
}

function createTest({ literal, isAnchoredAtStart, isAnchoredAtEnd }: Omit<LiteralPattern, 'test'>): (text: string) => boolean {
  if (isAnchoredAtStart && isAnchoredAtEnd) return text => text === literal || text === `${literal}${NEWLINE}`;
  if (isAnchoredAtStart) return text => text.startsWith(literal);
  if (isAnchoredAtEnd) return text => text.endsWith(literal) || text.endsWith(`${literal}${NEWLINE}`);
  return text => text.includes(literal);
}

/**
 * The ONE way a literal pattern is written once MXDB has read it: anchors kept, every metacharacter escaped, every
 * other character (including `/` and `-`) written bare. `'^a\\/b'` and `'^a/b'` both become `'^a/b'`. Both engines
 * receive this text: MongoDB compiles it, the device parses it again with `parseLiteralPattern`.
 */
export function toCanonicalPattern({ literal, isAnchoredAtStart, isAnchoredAtEnd }: LiteralPattern): string {
  const escaped = Array.from(literal).map(character => (METACHARACTERS.has(character) ? `\\${character}` : character)).join('');
  return `${isAnchoredAtStart ? '^' : ''}${escaped}${isAnchoredAtEnd ? '$' : ''}`;
}

/** The pattern parsed, or undefined when it is not a literal pattern MXDB accepts. */
export function parseLiteralPattern(pattern: string): LiteralPattern | undefined {
  if (pattern.length > MAX_PATTERN_LENGTH) return undefined;
  const characters = Array.from(pattern);
  if (characters.some(isRefusedCharacter)) return undefined;
  const isAnchoredAtStart = characters[0] === '^';
  let index = isAnchoredAtStart ? 1 : 0;
  let literal = '';
  let isAnchoredAtEnd = false;
  while (index < characters.length) {
    const character = characters[index]!;
    if (character === '\\') {
      const escaped = characters[index + 1];
      if (escaped == null || !ESCAPABLE.has(escaped)) return undefined;
      literal += escaped;
      index += 2;
      continue;
    }
    if (character === '$' && index === characters.length - 1) { isAnchoredAtEnd = true; index += 1; continue; }
    if (METACHARACTERS.has(character)) return undefined;
    literal += character;
    index += 1;
  }
  const parts = { literal, isAnchoredAtStart, isAnchoredAtEnd };
  return { ...parts, test: createTest(parts) };
}
