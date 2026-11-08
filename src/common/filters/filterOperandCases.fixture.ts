import type { DataFilters, Record } from '@anupheaus/common';

// Test-only: one table of filter conditions with an empty or broken operand, run against the device (DbCollection and
// its in-memory evaluator) and the server (MongoDB). Every operand that is missing, null or of the wrong type must match
// NOTHING on both — never be dropped, which reads every record (Vision sc-2518).

export interface OperandCaseRecord extends Record {
  name: string;
  category?: string | null;
  value?: number;
  tags?: string[];
  lines?: OperandCaseLine[];
}

/** A line item: `$elemMatch` must find product AND quantity on the SAME line (sc-2758). */
export interface OperandCaseLine {
  id?: string;
  product: string;
  quantity: number;
}

/**
 * One record per shape a field can take: set, set to another value, empty string, null, and missing. The tags are
 * sc-2758's QA example (A: x and y, B: x, C: none, D and E: no tags field); r1's lines hold product P and quantity 2
 * on DIFFERENT lines.
 */
export const OPERAND_CASE_RECORDS: OperandCaseRecord[] = [
  { id: 'r1', name: 'One', category: 'a', value: 10, tags: ['x', 'y'], lines: [{ product: 'P', quantity: 1 }, { product: 'Q', quantity: 2 }] },
  { id: 'r2', name: 'Two', category: 'b', value: 20, tags: ['x'], lines: [{ id: 'L1', product: 'P', quantity: 3 }] },
  { id: 'r3', name: 'Three', category: '', value: 30, tags: [], lines: [{ product: 'Q', quantity: 5 }, { product: 'P', quantity: 2 }] },
  { id: 'r4', name: 'Four', category: null, value: 40, lines: [] },
  { id: 'r5', name: 'Five' },
];

const ALL_IDS = OPERAND_CASE_RECORDS.map(({ id }) => id);
const NOTHING: string[] = [];

/** Which engines understand the operator: MongoDB has no `$ni` / `$like` / `$beginsWith` / `$endsWith`. */
export type OperandCaseEngines = 'both' | 'device' | 'server';

export interface OperandCase {
  label: string;
  filters: DataFilters<OperandCaseRecord>;
  expectedIds: string[];
  engines: OperandCaseEngines;
}

type Loose = DataFilters<OperandCaseRecord>;

interface OperatorRow {
  operator: string;
  field: keyof OperandCaseRecord;
  engines: OperandCaseEngines;
  /** The operator's empty operand and what it matches; absent where the operator has no empty value. */
  empty?: { operand: unknown; expectedIds: string[] };
  /** An operand of the wrong type; absent where every defined value is acceptable ($eq / $ne). */
  wrongType?: unknown;
}

const OPERATOR_ROWS: OperatorRow[] = [
  { operator: '$eq', field: 'category', engines: 'both', empty: { operand: '', expectedIds: ['r3'] } },
  { operator: '$ne', field: 'category', engines: 'both', empty: { operand: '', expectedIds: ['r1', 'r2', 'r4', 'r5'] } },
  { operator: '$gt', field: 'value', engines: 'both', wrongType: { at: 1 } },
  { operator: '$gte', field: 'value', engines: 'both', wrongType: [10] },
  { operator: '$lt', field: 'value', engines: 'both', wrongType: { at: 1 } },
  { operator: '$lte', field: 'value', engines: 'both', wrongType: [10] },
  { operator: '$in', field: 'category', engines: 'both', empty: { operand: [], expectedIds: NOTHING }, wrongType: 'a' },
  { operator: '$nin', field: 'category', engines: 'both', empty: { operand: [], expectedIds: ALL_IDS }, wrongType: 'a' },
  // Not in the whitelist (device-only, or reading differently on each engine): matches nothing whatever its operand.
  { operator: '$ni', field: 'category', engines: 'both', empty: { operand: [], expectedIds: NOTHING }, wrongType: 'a' },
  { operator: '$all', field: 'tags', engines: 'both', empty: { operand: [], expectedIds: NOTHING }, wrongType: 'x' },
  { operator: '$size', field: 'tags', engines: 'both', empty: { operand: 0, expectedIds: NOTHING }, wrongType: '1' },
  { operator: '$exists', field: 'category', engines: 'both', wrongType: 'yes' },
  { operator: '$regex', field: 'category', engines: 'both', empty: { operand: '', expectedIds: ['r1', 'r2', 'r3'] }, wrongType: 5 },
  { operator: '$elemMatch', field: 'tags', engines: 'both', empty: { operand: {}, expectedIds: NOTHING }, wrongType: 'x' },
  { operator: '$not', field: 'category', engines: 'both', empty: { operand: {}, expectedIds: NOTHING }, wrongType: 'x' },
  { operator: '$bogus', field: 'category', engines: 'both', wrongType: 1 },
  { operator: '$like', field: 'category', engines: 'both', empty: { operand: '', expectedIds: NOTHING }, wrongType: 5 },
  { operator: '$beginsWith', field: 'category', engines: 'both', empty: { operand: '', expectedIds: NOTHING }, wrongType: 5 },
  { operator: '$endsWith', field: 'category', engines: 'both', empty: { operand: '', expectedIds: NOTHING }, wrongType: 5 },
  { operator: '$type', field: 'category', engines: 'both', empty: { operand: '', expectedIds: NOTHING }, wrongType: 'string' },
];

const LOGICAL_ROWS: { operator: '$or' | '$and' | '$nor'; engines: OperandCaseEngines }[] = [
  { operator: '$or', engines: 'both' },
  { operator: '$and', engines: 'both' },
  { operator: '$nor', engines: 'both' },
];

function operatorCases({ operator, field, engines, empty, wrongType }: OperatorRow): OperandCase[] {
  const condition = (operand: unknown) => ({ [field]: { [operator]: operand } }) as Loose;
  const cases: OperandCase[] = [
    { label: `${operator}: undefined`, filters: condition(undefined), expectedIds: NOTHING, engines },
    { label: `${operator}: null`, filters: condition(null), expectedIds: NOTHING, engines },
  ];
  if (empty != null) cases.push({ label: `${operator}: empty (${JSON.stringify(empty.operand)})`, filters: condition(empty.operand), expectedIds: empty.expectedIds, engines });
  if (wrongType !== undefined) cases.push({ label: `${operator}: wrong type (${JSON.stringify(wrongType)})`, filters: condition(wrongType), expectedIds: NOTHING, engines });
  return cases;
}

function logicalCases({ operator, engines }: typeof LOGICAL_ROWS[number]): OperandCase[] {
  const filters = (operand: unknown) => ({ [operator]: operand }) as Loose;
  return [
    { label: `${operator}: undefined`, filters: filters(undefined), expectedIds: NOTHING, engines },
    { label: `${operator}: null`, filters: filters(null), expectedIds: NOTHING, engines },
    { label: `${operator}: empty ([])`, filters: filters([]), expectedIds: NOTHING, engines },
    { label: `${operator}: wrong type ("x")`, filters: filters('x'), expectedIds: NOTHING, engines },
  ];
}

/**
 * sc-2758: a filter that matches inside a list. Its acceptance criteria 1-5 over the QA example records: the device,
 * its in-memory evaluator and the server must each return exactly these records.
 */
const ELEM_MATCH_CASES: OperandCase[] = [
  { label: 'sc-2758 #1: tags hold an item equal to "y"', filters: { tags: { $elemMatch: { $eq: 'y' } } } as Loose, expectedIds: ['r1'], engines: 'both' },
  { label: 'sc-2758 #2: tags hold an item equal to "x"', filters: { tags: { $elemMatch: { $eq: 'x' } } } as Loose, expectedIds: ['r1', 'r2'], engines: 'both' },
  { label: 'sc-2758 #3: tags hold an item equal to "z" (no record)', filters: { tags: { $elemMatch: { $eq: 'z' } } } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'sc-2758 #4: product P and quantity at least 2 on the SAME line', filters: { lines: { $elemMatch: { product: 'P', quantity: { $gte: 2 } } } } as Loose, expectedIds: ['r2', 'r3'], engines: 'both' },
  { label: 'sc-2758 #4: without $elemMatch, the two may be on different lines', filters: { 'lines.product': 'P', 'lines.quantity': { $gte: 2 } } as Loose, expectedIds: ['r1', 'r2', 'r3'], engines: 'both' },
  { label: 'sc-2758: a line\'s own id is the line\'s, not the record\'s', filters: { lines: { $elemMatch: { id: 'L1' } } } as Loose, expectedIds: ['r2'], engines: 'both' },
  { label: 'sc-2758: two bounds on the same item', filters: { tags: { $elemMatch: { $gte: 'x', $lt: 'y' } } } as Loose, expectedIds: ['r1', 'r2'], engines: 'both' },
  { label: 'sc-2758: an item that is not "x"', filters: { tags: { $elemMatch: { $not: { $eq: 'x' } } } } as Loose, expectedIds: ['r1'], engines: 'both' },
  { label: 'sc-2758: an item in a list of values', filters: { tags: { $elemMatch: { $in: ['y', 'z'] } } } as Loose, expectedIds: ['r1'], engines: 'both' },
  { label: 'sc-2758: any item at all ($nin of nothing)', filters: { tags: { $elemMatch: { $nin: [] } } } as Loose, expectedIds: ['r1', 'r2'], engines: 'both' },
  { label: 'sc-2758: a line meeting either branch', filters: { lines: { $elemMatch: { $or: [{ product: 'Q' }, { quantity: { $gte: 3 } }] } } } as Loose, expectedIds: ['r1', 'r2', 'r3'], engines: 'both' },
  { label: 'sc-2758: a field that is not a list never matches', filters: { name: { $elemMatch: { $eq: 'One' } } } as Loose, expectedIds: NOTHING, engines: 'both' },
  // #5: forms MXDB does not evaluate inside a list match nothing on every engine, never every record.
  { label: 'sc-2758 #5: $size on an item', filters: { tags: { $elemMatch: { $size: 1 } } } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'sc-2758 #5: $exists on an item', filters: { tags: { $elemMatch: { $exists: true } } } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'sc-2758 #5: $all on an item', filters: { tags: { $elemMatch: { $all: ['x'] } } } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'sc-2758 #5: $elemMatch on an item', filters: { tags: { $elemMatch: { $elemMatch: { $eq: 'x' } } } } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'sc-2758 #5: operators and fields mixed', filters: { lines: { $elemMatch: { $eq: 'P', product: 'P' } } } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'sc-2758: a nested condition in a line is a dotted path (none has product.name)', filters: { lines: { $elemMatch: { product: { name: 'P' } } } } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'sc-2758 #5: a bare list of values', filters: { tags: { $elemMatch: ['x'] } } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'sc-2783: a case-insensitive pattern on an item', filters: { tags: { $elemMatch: { $regex: 'X', $options: 'i' } } } as Loose, expectedIds: ['r1', 'r2'], engines: 'both' },
  { label: 'sc-2783: a pattern option no engine honours alike, on an item', filters: { tags: { $elemMatch: { $regex: 'x', $options: 'm' } } } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'sc-2758 #5: negated, an unreadable form is still nothing', filters: { tags: { $not: { $elemMatch: { $size: 1 } } } } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'sc-2758 #5: under $nor, an unreadable form is still nothing', filters: { $nor: [{ lines: { $elemMatch: { $where: 'true' } } }] } as Loose, expectedIds: NOTHING, engines: 'both' },
];

/**
 * Every operator × (undefined, null, empty, wrong type), plus a broken operand beside a sound condition, and the
 * conditions that must keep matching: a field with no value matches records missing it, and no filter reads everything.
 */
export const OPERAND_CASES: OperandCase[] = [
  ...OPERATOR_ROWS.flatMap(operatorCases),
  ...LOGICAL_ROWS.flatMap(logicalCases),
  { label: 'a broken operand beside a sound condition', filters: { name: 'One', category: { $in: undefined } } as Loose, expectedIds: NOTHING, engines: 'both' },
  // A broken node anywhere makes the WHOLE query match nothing, so nothing broken can be negated into "everything".
  { label: 'a broken operand inside one $or branch', filters: { $or: [{ category: { $in: undefined } }, { name: 'Two' }] } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'a broken operand in a nested $and', filters: { $and: [{ name: { $in: ['One', 'Two'] } }, { $or: [{ value: { $gt: undefined } }] }] } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'a broken operand inside a $nor branch', filters: { $nor: [{ category: { $in: undefined } }] } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'a broken operand inside $not', filters: { category: { $not: { $in: undefined } } } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'a broken operand inside $elemMatch', filters: { tags: { $elemMatch: { $in: undefined } } } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'a broken operand under $nor and $not', filters: { $nor: [{ $or: [{ category: { $not: { $eq: null } } }] }] } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'an empty field condition', filters: { value: {} } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'an empty field condition inside $or', filters: { $or: [{ category: {} }] } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'an empty nested path', filters: { category: { sub: {} } } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'operators and fields mixed in one condition', filters: { category: { $eq: 'a', sub: 1 } } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'an unknown top-level operator', filters: { $where: 'true' } as Loose, expectedIds: NOTHING, engines: 'both' },
  // Sound queries using the same operators keep working, on both engines.
  { label: 'a sound $nor', filters: { $nor: [{ category: 'a' }, { value: { $gte: 30 } }] } as Loose, expectedIds: ['r2', 'r5'], engines: 'both' },
  { label: 'a sound $not', filters: { value: { $not: { $gt: 15 } } } as Loose, expectedIds: ['r1', 'r5'], engines: 'both' },
  ...ELEM_MATCH_CASES,
  { label: 'an empty branch is "no condition"', filters: { $and: [{}, { name: 'Two' }] } as Loose, expectedIds: ['r2'], engines: 'both' },
  { label: 'a sound $regex', filters: { name: { $regex: '^T' } } as Loose, expectedIds: ['r2', 'r3'], engines: 'both' },
  { label: 'a sound negated $regex counts a missing field as "not"', filters: { category: { $not: { $regex: '^a' } } } as Loose, expectedIds: ['r2', 'r3', 'r4', 'r5'], engines: 'both' },
  // QA round 3's four holes: each read every record on the device. $elemMatch is now readable (sc-2758), so its
  // negations are exact: every record without a "y" tag, including those with no tags at all.
  { label: 'QA r3 #1: $elemMatch under $not', filters: { tags: { $not: { $elemMatch: { $eq: 'y' } } } } as Loose, expectedIds: ['r2', 'r3', 'r4', 'r5'], engines: 'both' },
  { label: 'QA r3 #1: $elemMatch under $nor', filters: { $nor: [{ tags: { $elemMatch: { $eq: 'y' } } }], name: { $exists: true } } as Loose, expectedIds: ['r2', 'r3', 'r4', 'r5'], engines: 'both' },
  // Since sc-2783 a case-insensitive literal pattern is readable, so these are exact negations / matches.
  { label: 'QA r3 #2: a flagged RegExp under $not', filters: { category: { $not: /A/i } } as Loose, expectedIds: ['r2', 'r3', 'r4', 'r5'], engines: 'both' },
  { label: 'QA r3 #2: a flagged $regex under $not', filters: { category: { $not: { $regex: /A/i } } } as Loose, expectedIds: ['r2', 'r3', 'r4', 'r5'], engines: 'both' },
  { label: 'QA r3 #2: $regex with $options', filters: { category: { $regex: 'A', $options: 'i' } } as Loose, expectedIds: ['r1'], engines: 'both' },
  { label: 'QA r3 #2: a RegExp with a flag no engine honours alike', filters: { category: { $not: /a/g } } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'QA r3 #2: a pattern that does not compile, under $not', filters: { category: { $not: { $regex: '(' } } } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'QA r3 #3: a non-object filter (true)', filters: true as unknown as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'QA r3 #3: a non-object filter (1)', filters: 1 as unknown as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'QA r3 #3: a non-object filter (\'\')', filters: '' as unknown as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'QA r3 #3: a non-object filter ([])', filters: [] as unknown as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'QA r3 #4: a field name that is not a field path', filters: { 'x\') OR 1=1 OR (\'': 1, name: { $exists: true } } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'a __proto__ field', filters: JSON.parse('{"__proto__": 1, "name": "One"}') as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'an empty field name', filters: { '': 1 } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'a nested condition on a text field reads a path no record has (sc-2783)', filters: { category: { sub: 'a' } } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'an array index in a field path (SQLite and MongoDB read it differently)', filters: { 'tags.0': 'x' } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'deeper than the limit', filters: Array.from({ length: 10 }).reduce<Loose>(inner => ({ $and: [inner] }) as Loose, { name: 'One' } as Loose), expectedIds: NOTHING, engines: 'both' },
  // QA round 5: shapes JavaScript and MongoDB's PCRE read differently, and a catastrophic pattern. Only literal
  // patterns are readable, so each of these matches nothing on both engines, plain and negated.
  { label: 'QA r5 #1: a POSIX class under $not', filters: { name: { $not: { $regex: '[[:alpha:]]' } } } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'QA r5 #1: \\p{L} under $not', filters: { name: { $not: { $regex: '\\p{L}' } } } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'QA r5 #1: \\A under $not', filters: { name: { $not: { $regex: '\\AO' } } } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'QA r5 #1: \\Z', filters: { name: { $regex: 'e\\Z' } } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'QA r5 #1: a catastrophic pattern', filters: { name: { $regex: '^(a+)+$' } } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'QA r5 #1: a pattern longer than the cap', filters: { name: { $not: { $regex: 'a'.repeat(129) } } } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'a literal pattern with an escaped metacharacter', filters: { name: { $not: { $regex: 'T\\.' } } } as Loose, expectedIds: ALL_IDS, engines: 'both' },
  // QA round 5 #2: the bare-list shorthand is $in on both engines (MongoDB alone would read "equals this list").
  { label: 'QA r5 #2: a bare list', filters: { category: ['a', 'b'] } as Loose, expectedIds: ['r1', 'r2'], engines: 'both' },
  { label: 'QA r5 #2: a bare list under $nor', filters: { $nor: [{ category: ['a', 'b'] }] } as Loose, expectedIds: ['r3', 'r4', 'r5'], engines: 'both' },
  { label: 'a field with no value matches records missing it', filters: { category: undefined } as Loose, expectedIds: ['r4', 'r5'], engines: 'both' },
  { label: 'a list holding a missing value matches records missing the field', filters: { category: { $in: ['a', undefined] } } as Loose, expectedIds: ['r1', 'r4', 'r5'], engines: 'both' },
  { label: 'an empty filter reads everything', filters: {}, expectedIds: ALL_IDS, engines: 'both' },
];

/** The cases one engine understands. */
export function operandCasesFor(engine: 'device' | 'server'): [string, OperandCase][] {
  return OPERAND_CASES
    .filter(({ engines }) => engines === 'both' || engines === engine)
    .map(operandCase => [operandCase.label, operandCase]);
}

// ─── sc-2783: the four filters that read differently on the device and the server ──

export interface ParityCaseRecord extends Record {
  name: string;
  value?: number | string | null;
  address?: { city?: string | null; zip?: string };
  linkedTo?: { kind: string; id: string };
  category?: string;
}

/**
 * sc-2783's QA example: values 30, 10, the text '5', the text '60', null and none; addresses with and without a city
 * of Leeds (one with another field beside it); links of two kinds; categories in mixed case.
 */
export const PARITY_CASE_RECORDS: ParityCaseRecord[] = [
  { id: 'p1', name: 'Thirty', value: 30, address: { city: 'Leeds', zip: 'LS1' }, linkedTo: { kind: 'lead', id: 'L1' }, category: 'Apple' },
  { id: 'p2', name: 'Ten', value: 10, address: { city: 'York' }, linkedTo: { kind: 'lead', id: 'L2' }, category: 'banana' },
  { id: 'p3', name: 'Five', value: '5', address: { city: 'Leeds' }, linkedTo: { kind: 'job', id: 'L1' }, category: 'APRICOT' },
  { id: 'p4', name: 'Sixty', value: '60', address: { zip: 'LS2' }, linkedTo: { kind: 'lead', id: 'L3' }, category: 'cherry' },
  { id: 'p5', name: 'Null', value: null, address: { city: null }, category: 'Ålborg' },
  { id: 'p6', name: 'None' },
];

type ParityFilters = DataFilters<ParityCaseRecord>;

/** Its acceptance criteria 1-4 and 6 as rows: every engine must return exactly these records. */
export const PARITY_CASES: OperandCase[] = ([
  // 1-2: comparisons match only values of the same kind.
  { label: 'sc-2783 #1: value greater than 25 (a number) is only the number 30', filters: { value: { $gt: 25 } }, expectedIds: ['p1'] },
  { label: 'sc-2783 #2: value less than \'50\' (text) is only the text below it', filters: { value: { $lt: '50' } }, expectedIds: ['p3'] },
  { label: 'sc-2783 #2: value at least \'50\' (text) is only the text above it', filters: { value: { $gte: '50' } }, expectedIds: ['p4'] },
  // 3: "does not exist" means absent; "missing" means absent or null.
  { label: 'sc-2783 #3: value does not exist is only the record with no value', filters: { value: { $exists: false } }, expectedIds: ['p6'] },
  { label: 'sc-2783 #3: value exists includes the null one', filters: { value: { $exists: true } }, expectedIds: ['p1', 'p2', 'p3', 'p4', 'p5'] },
  { label: 'sc-2783 #3: value is missing (no value written) is null or absent', filters: { value: undefined }, expectedIds: ['p5', 'p6'] },
  // 4: a nested condition means each nested field listed matches; a nested id stays id.
  { label: 'sc-2783 #4: address city is Leeds, written nested', filters: { address: { city: 'Leeds' } }, expectedIds: ['p1', 'p3'] },
  { label: 'sc-2783 #4: address city is Leeds, written as a path', filters: { 'address.city': 'Leeds' } as ParityFilters, expectedIds: ['p1', 'p3'] },
  { label: 'sc-2783 #4: a nested kind and a list of ids', filters: { linkedTo: { kind: 'lead', id: { $in: ['L1', 'L2'] } } }, expectedIds: ['p1', 'p2'] },
  { label: 'sc-2783 #4: a nested id alone', filters: { linkedTo: { id: 'L1' } }, expectedIds: ['p1', 'p3'] },
  { label: 'sc-2783 #4: a nested missing city', filters: { address: { city: null } }, expectedIds: ['p4', 'p5', 'p6'] },
  { label: 'sc-2783 #4: a nested condition under $nor', filters: { $nor: [{ linkedTo: { kind: 'lead' } }] }, expectedIds: ['p3', 'p5', 'p6'] },
  { label: 'sc-2783 #4: the same path nested and dotted keeps both conditions', filters: { address: { city: 'Leeds' }, 'address.city': { $ne: 'York' } } as ParityFilters, expectedIds: ['p1', 'p3'] },
  { label: 'sc-2783 #4: the same path nested and dotted, contradicting', filters: { address: { city: 'Leeds' }, 'address.city': 'York' } as ParityFilters, expectedIds: [] },
  { label: 'sc-2783 #4: an empty nested condition still matches nothing', filters: { address: { city: {} } } as ParityFilters, expectedIds: [] },
  // 6: a case-insensitive pattern, as text with $options or as a RegExp, reaches the server intact.
  { label: 'sc-2783 #6: category matches "a" ignoring case ($options)', filters: { category: { $regex: 'a', $options: 'i' } }, expectedIds: ['p1', 'p2', 'p3'] },
  { label: 'sc-2783 #6: category matches /a/i (a RegExp)', filters: { category: /a/i } as ParityFilters, expectedIds: ['p1', 'p2', 'p3'] },
  { label: 'sc-2783 #6: category matches { $regex: /^ap/i }', filters: { category: { $regex: /^ap/i } } as ParityFilters, expectedIds: ['p1', 'p3'] },
  { label: 'sc-2783 #6: category does not match /a/i', filters: { category: { $not: /a/i } } as ParityFilters, expectedIds: ['p4', 'p5', 'p6'] },
  { label: 'sc-2783 #6: case still matters without the option', filters: { category: { $regex: 'A' } }, expectedIds: ['p1', 'p3'] },
  { label: 'sc-2783 #6: an anchored case-insensitive pattern', filters: { category: { $regex: '^CHERRY$', $options: 'i' } }, expectedIds: ['p4'] },
  { label: 'sc-2783 #6: a letter outside ASCII, ignoring case', filters: { category: { $regex: 'åL', $options: 'i' } }, expectedIds: ['p5'] },
  { label: 'sc-2783 #6: an empty $options is no option', filters: { category: { $regex: 'A', $options: '' } }, expectedIds: ['p1', 'p3'] },
  { label: 'sc-2783 #6: option m matches nothing', filters: { category: { $regex: 'a', $options: 'm' } }, expectedIds: [] },
  { label: 'sc-2783 #6: option x matches nothing', filters: { category: { $regex: 'a', $options: 'ix' } }, expectedIds: [] },
  { label: 'sc-2783 #6: option s under $not matches nothing', filters: { category: { $not: { $regex: 'a', $options: 's' } } }, expectedIds: [] },
  { label: 'sc-2783 #6: $options without a $regex matches nothing', filters: { category: { $options: 'i' } } as ParityFilters, expectedIds: [] },
  { label: 'sc-2783 #6: a RegExp $regex beside $options matches nothing', filters: { category: { $regex: /a/, $options: 'i' } } as ParityFilters, expectedIds: [] },
  { label: 'sc-2783 #6: a RegExp with flag u matches nothing', filters: { category: /a/u } as ParityFilters, expectedIds: [] },
  { label: 'sc-2783 #6: a RegExp that is not a literal pattern matches nothing', filters: { category: /a.c/i } as ParityFilters, expectedIds: [] },
  { label: 'sc-2783 #6: a RegExp in a list matches nothing', filters: { category: { $in: [/a/i] } } as ParityFilters, expectedIds: [] },
] as Omit<OperandCase, 'engines'>[]).map(parityCase => ({ ...parityCase, engines: 'both' }));

/** The sc-2783 rows, labelled for `it.each`. */
export function parityCases(): [string, OperandCase][] {
  return PARITY_CASES.map(parityCase => [parityCase.label, parityCase]);
}
