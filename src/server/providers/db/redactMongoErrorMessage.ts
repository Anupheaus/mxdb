/** Matches the document a duplicate-key (E11000) message quotes: `dup key: { email: "a@b.c" }`. */
const DUPLICATE_KEY_VALUES = /dup key: \{[^}]*\}/g;

/**
 * Removes customer data from a Mongo error message or stack before it is logged. A duplicate-key
 * message quotes the offending values, so it is replaced with just the shape.
 */
export function redactMongoErrorMessage(message: string): string {
  return message.replace(DUPLICATE_KEY_VALUES, 'dup key: { <redacted> }');
}
