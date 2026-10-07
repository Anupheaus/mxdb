import type { DataFilters, Record } from '@anupheaus/common';

// Test-only: one table of filter conditions with an empty or broken operand, run against the device (SQLite and the
// in-memory path) and the server (MongoDB). Every operand that is missing, null or of the wrong type must match
// NOTHING on both — never be dropped, which reads every record (Vision sc-2518).

export interface OperandCaseRecord extends Record {
  name: string;
  category?: string | null;
  value?: number;
  tags?: string[];
}

/** One record per shape a field can take: set, set to another value, empty string, null, and missing. */
export const OPERAND_CASE_RECORDS: OperandCaseRecord[] = [
  { id: 'r1', name: 'One', category: 'a', value: 10, tags: ['x', 'y'] },
  { id: 'r2', name: 'Two', category: 'b', value: 20, tags: ['x'] },
  { id: 'r3', name: 'Three', category: '', value: 30, tags: [] },
  { id: 'r4', name: 'Four', category: null, value: 40 },
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
  /**
   * What the device's SQL path alone returns, where it differs: it does not translate `$elemMatch` yet (sc-2758) and
   * matches nothing for it — never everything — leaving `$elemMatch` to the in-memory path.
   */
  deviceSqlIds?: string[];
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
  { label: '$elemMatch is not in the whitelist (sc-2758)', filters: { tags: { $elemMatch: { $eq: 'y' } } } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'an empty branch is "no condition"', filters: { $and: [{}, { name: 'Two' }] } as Loose, expectedIds: ['r2'], engines: 'both' },
  { label: 'a sound $regex', filters: { name: { $regex: '^T' } } as Loose, expectedIds: ['r2', 'r3'], engines: 'both' },
  { label: 'a sound negated $regex counts a missing field as "not"', filters: { category: { $not: { $regex: '^a' } } } as Loose, expectedIds: ['r2', 'r3', 'r4', 'r5'], engines: 'both' },
  // QA round 3's four holes: each read every record on the device.
  { label: 'QA r3 #1: $elemMatch under $not', filters: { tags: { $not: { $elemMatch: { $eq: 'y' } } } } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'QA r3 #1: $elemMatch under $nor', filters: { $nor: [{ tags: { $elemMatch: { $eq: 'y' } } }], name: { $exists: true } } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'QA r3 #2: a flagged RegExp under $not', filters: { category: { $not: /A/i } } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'QA r3 #2: a flagged $regex under $not', filters: { category: { $not: { $regex: /A/i } } } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'QA r3 #2: $regex with $options', filters: { category: { $regex: 'a', $options: 'i' } } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'QA r3 #2: a pattern that does not compile, under $not', filters: { category: { $not: { $regex: '(' } } } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'QA r3 #3: a non-object filter (true)', filters: true as unknown as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'QA r3 #3: a non-object filter (1)', filters: 1 as unknown as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'QA r3 #3: a non-object filter (\'\')', filters: '' as unknown as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'QA r3 #3: a non-object filter ([])', filters: [] as unknown as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'QA r3 #4: a field name that is not a field path', filters: { 'x\') OR 1=1 OR (\'': 1, name: { $exists: true } } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'a __proto__ field', filters: JSON.parse('{"__proto__": 1, "name": "One"}') as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'an empty field name', filters: { '': 1 } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'a nested-object field value (sc-2783)', filters: { category: { sub: 'a' } } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'an array index in a field path (SQLite and MongoDB read it differently)', filters: { 'tags.0': 'x' } as Loose, expectedIds: NOTHING, engines: 'both' },
  { label: 'deeper than the limit', filters: Array.from({ length: 10 }).reduce<Loose>(inner => ({ $and: [inner] }) as Loose, { name: 'One' } as Loose), expectedIds: NOTHING, engines: 'both' },
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
