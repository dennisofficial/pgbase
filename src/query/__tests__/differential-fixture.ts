import type { Pool } from 'pg';
import { PgCatalogSchemaProvider } from '../../schema/resolver.js';
import type { ResolvedModel, StaticField, StaticSchema } from '../../schema/types.js';
import { SCHEMA_FORMAT_VERSION } from '../../version.js';
import {
  JSON_NULL,
  formatArrayLiteral,
  formatParamText,
  parseTimestampMicros,
} from '../compare.js';

export const TABLE = 'pgbase_differential_fixture';

export const ENUM_TYPE = 'pgbase_differential_status';
export const ENUM_NAME = 'FixtureStatus';
export const ENUM_VALUES = ['QUEUED', 'RUNNING', 'DONE', 'FAILED'] as const;

export const STATUS = {
  queued: 'QUEUED',
  running: 'RUNNING',
  done: 'DONE',
  failed: 'FAILED',
};

function tz(iso: string): bigint {
  return parseTimestampMicros(`${iso}Z`, true);
}
function plain(iso: string): bigint {
  return parseTimestampMicros(iso, false);
}

export const UUID_A = '11111111-1111-1111-1111-111111111111';
export const UUID_B = '22222222-2222-2222-2222-222222222222';
export const UUID_ZERO = '00000000-0000-0000-0000-000000000000';
export const UUID_F = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

export const I8 = {
  zero: 0n,
  one: 1n,
  negOne: -1n,
  safeMax: 9007199254740991n, // 2^53 - 1
  safePlus1: 9007199254740992n, // 2^53
  safePlus2: 9007199254740993n, // 2^53 + 1
  safePlus3: 9007199254740994n,
  negSafePlus2: -9007199254740993n,
  int8Max: 9223372036854775807n,
  int8Min: -9223372036854775808n,
};

export const NUM = {
  zero: '0.00000',
  negZero: '-0.00000',
  one: '1.00000',
  onePlusEps: '1.00001',
  negOne: '-1.00000',
  negOnePlusEps: '-1.00001',
  small: '0.00001',
  negSmall: '-0.00001',
  big: '123456789012345.12345',
};

export const F8 = { zero: 0, negOne5: -1.5, one5: 1.5, sum: 0.1 + 0.2, big: 1e10 };

export const TXT = {
  empty: '',
  a: 'a',
  A: 'A',
  ab: 'ab',
  percent: 'a%b',
  underscore: 'a_b',
  backslash: 'a\\b',
  unicode: 'héllo',
  unicodeUpper: 'HÉLLO',
  mixedCase: 'MixedCase',
  mixedCaseLower: 'mixedcase',
  dup: 'dup',
};

export const DATE = {
  d0: '1954-03-17',
  d1: '1999-12-31',
  d2: '2000-01-01',
  d3: '2024-06-15',
  d4: '2024-06-16',
};

const TS_BASE = '2024-06-15T10:00:00.123456';
const TS_MINUS1US = '2024-06-15T10:00:00.123455';
const TS_PLUS1US = '2024-06-15T10:00:00.123457';
const TS_PRE_EPOCH = '1954-03-17T04:05:06.123456';
const TS_PRE_EPOCH_PLUS1US = '1954-03-17T04:05:06.123457';

export const TS = {
  base: plain(TS_BASE),
  minus1us: plain(TS_MINUS1US),
  plus1us: plain(TS_PLUS1US),
  preEpoch: plain(TS_PRE_EPOCH),
  preEpochPlus1us: plain(TS_PRE_EPOCH_PLUS1US),
};
export const TSTZ = {
  base: tz(TS_BASE),
  minus1us: tz(TS_MINUS1US),
  plus1us: tz(TS_PLUS1US),
  preEpoch: tz(TS_PRE_EPOCH),
  preEpochPlus1us: tz(TS_PRE_EPOCH_PLUS1US),
};

export const ARR = {
  empty: [] as readonly string[],
  one: ['a'] as readonly string[],
  dup: ['a', 'a'] as readonly string[],
  ab: ['a', 'b'] as readonly string[],
  ba: ['b', 'a'] as readonly string[],
  withEmptyStr: ['', 'x'] as readonly string[],
  // A stored NULL *element* (not a NULL column). `= ANY` propagates NULL through it while `&&`
  // and `@>` do not, so `has` must go unknown here where `hasSome`/`hasEvery` go false.
  withNullElem: ['a', null] as readonly (string | null)[],
  onlyNullElem: [null] as readonly (string | null)[],
};

export const JS = {
  emptyObj: {},
  a1: { a: 1 },
  a2: { a: 2 },
  arr123: [1, 2, 3],
  str: 'hello',
  num: 42,
  bool: true,
  nested: { a: { b: [1, { c: 2 }] } },
  jsonNull: JSON_NULL,
};

const COLUMNS: readonly {
  name: string;
  ddlType: string;
  nullable: boolean;
  enumName?: string;
}[] = [
  { name: 'c_bool', ddlType: 'boolean', nullable: false },
  { name: 'c_bool_n', ddlType: 'boolean', nullable: true },
  { name: 'c_int4', ddlType: 'integer', nullable: false },
  { name: 'c_int4_n', ddlType: 'integer', nullable: true },
  { name: 'c_int8', ddlType: 'bigint', nullable: false },
  { name: 'c_int8_n', ddlType: 'bigint', nullable: true },
  { name: 'c_numeric', ddlType: 'numeric(20,5)', nullable: false },
  { name: 'c_numeric_n', ddlType: 'numeric(20,5)', nullable: true },
  { name: 'c_float8', ddlType: 'double precision', nullable: false },
  { name: 'c_float8_n', ddlType: 'double precision', nullable: true },
  { name: 'c_text', ddlType: 'text', nullable: false },
  { name: 'c_text_n', ddlType: 'text', nullable: true },
  { name: 'c_uuid', ddlType: 'uuid', nullable: false },
  { name: 'c_uuid_n', ddlType: 'uuid', nullable: true },
  { name: 'c_date', ddlType: 'date', nullable: false },
  { name: 'c_date_n', ddlType: 'date', nullable: true },
  { name: 'c_ts', ddlType: 'timestamp(6)', nullable: false },
  { name: 'c_ts_n', ddlType: 'timestamp(6)', nullable: true },
  { name: 'c_tstz', ddlType: 'timestamptz(6)', nullable: false },
  { name: 'c_tstz_n', ddlType: 'timestamptz(6)', nullable: true },
  { name: 'c_arr', ddlType: 'text[]', nullable: false },
  { name: 'c_arr_n', ddlType: 'text[]', nullable: true },
  { name: 'c_json', ddlType: 'jsonb', nullable: false },
  { name: 'c_json_n', ddlType: 'jsonb', nullable: true },
  { name: 'c_enum', ddlType: `"${ENUM_TYPE}"`, nullable: false, enumName: ENUM_NAME },
  { name: 'c_enum_n', ddlType: `"${ENUM_TYPE}"`, nullable: true, enumName: ENUM_NAME },
  { name: 'c_enum_arr', ddlType: `"${ENUM_TYPE}"[]`, nullable: false, enumName: ENUM_NAME },
];

const DEFAULTS: Record<string, unknown> = {
  c_bool: true,
  c_bool_n: true,
  c_int4: 5,
  c_int4_n: 5,
  c_int8: I8.one,
  c_int8_n: I8.one,
  c_numeric: NUM.one,
  c_numeric_n: NUM.one,
  c_float8: F8.one5,
  c_float8_n: F8.one5,
  c_text: TXT.a,
  c_text_n: TXT.a,
  c_uuid: UUID_A,
  c_uuid_n: UUID_A,
  c_date: DATE.d3,
  c_date_n: DATE.d3,
  c_ts: TS.base,
  c_ts_n: TS.base,
  c_tstz: TSTZ.base,
  c_tstz_n: TSTZ.base,
  c_arr: ARR.ab,
  c_arr_n: ARR.ab,
  c_json: JS.a1,
  c_json_n: JS.a1,
  c_enum: STATUS.queued,
  c_enum_n: STATUS.queued,
  c_enum_arr: [STATUS.queued, STATUS.running],
};

function row(id: number, overrides: Record<string, unknown>): Record<string, unknown> {
  return { id, ...DEFAULTS, ...overrides };
}

export const ROWS: readonly Record<string, unknown>[] = [
  row(1, {}),
  row(2, { c_bool: false, c_bool_n: null }),
  row(3, { c_int8: I8.zero }),
  row(4, { c_int8: I8.negOne }),
  row(5, { c_int8: I8.safeMax }),
  row(6, { c_int8: I8.safePlus1 }),
  row(7, { c_int8: I8.safePlus2 }),
  row(8, { c_int8: I8.safePlus3 }),
  row(9, { c_int8: I8.negSafePlus2 }),
  row(10, { c_int8: I8.int8Max }),
  row(11, { c_int8: I8.int8Min, c_int8_n: null }),
  row(12, { c_numeric: NUM.zero }),
  row(13, { c_numeric: NUM.negZero }),
  row(14, { c_numeric: NUM.onePlusEps }),
  row(15, { c_numeric: NUM.negOne }),
  row(16, { c_numeric: NUM.negOnePlusEps }),
  row(17, { c_numeric: NUM.small }),
  row(18, { c_numeric: NUM.negSmall, c_numeric_n: null }),
  row(19, { c_numeric: NUM.big }),
  row(20, { c_tstz: TSTZ.minus1us, c_ts: TS.minus1us }),
  row(21, { c_tstz: TSTZ.plus1us, c_ts: TS.plus1us, c_tstz_n: null, c_ts_n: null }),
  row(22, { c_date: DATE.d1 }),
  row(23, { c_date: DATE.d2, c_date_n: null }),
  row(24, { c_text: TXT.empty }),
  row(25, { c_text: TXT.A }),
  row(26, { c_text: TXT.ab }),
  row(27, { c_text: TXT.percent }),
  row(28, { c_text: TXT.underscore }),
  row(29, { c_text: TXT.backslash }),
  row(30, { c_text: TXT.unicode }),
  row(31, { c_text: TXT.unicodeUpper }),
  row(32, { c_text: TXT.mixedCase, c_text_n: null }),
  row(33, { c_text: TXT.mixedCaseLower }),
  row(34, { c_text: TXT.dup }),
  row(35, { c_text: TXT.dup }),
  row(36, { c_uuid: UUID_B }),
  row(37, { c_uuid: UUID_ZERO }),
  row(38, { c_uuid: UUID_F, c_uuid_n: null }),
  row(39, { c_arr: ARR.empty }),
  row(40, { c_arr: ARR.one }),
  row(41, { c_arr: ARR.dup }),
  row(42, { c_arr: ARR.ba }),
  row(43, { c_arr: ARR.withEmptyStr, c_arr_n: null }),
  row(44, { c_json: JS.emptyObj }),
  row(45, { c_json: JS.a2 }),
  row(46, { c_json: JS.arr123 }),
  row(47, { c_json: JS.str }),
  row(48, { c_json: JS.num }),
  row(49, { c_json: JS.bool }),
  row(50, { c_json: JS.nested }),
  row(51, { c_json: JS.jsonNull, c_json_n: JS.jsonNull }),
  row(52, { c_json_n: null }),
  row(53, {
    c_bool_n: null,
    c_int4_n: null,
    c_int8_n: null,
    c_numeric_n: null,
    c_float8_n: null,
    c_text_n: null,
    c_uuid_n: null,
    c_date_n: null,
    c_ts_n: null,
    c_tstz_n: null,
    c_arr_n: null,
    c_json_n: null,
  }),
  row(54, { c_int4: -7, c_float8: F8.negOne5 }),
  row(55, { c_float8: F8.sum, c_float8_n: F8.zero }),
  row(56, { c_float8: F8.big }),
  row(57, { c_arr: ARR.withNullElem as readonly string[] }),
  row(58, { c_arr: ARR.onlyNullElem as readonly string[] }),
  // Pre-epoch: negative microsecond offsets, where floor-division must not round toward zero.
  row(59, { c_ts: TS.preEpoch, c_tstz: TSTZ.preEpoch, c_date: DATE.d0 }),
  row(60, { c_ts: TS.preEpochPlus1us, c_tstz: TSTZ.preEpochPlus1us }),
  // Enum: every declared member on the scalar columns, including the RUNNING/FAILED pair whose
  // declared order disagrees with text order.
  row(61, { c_enum: STATUS.running }),
  row(62, { c_enum: STATUS.failed }),
  row(63, { c_enum: STATUS.done, c_enum_n: STATUS.failed }),
  row(64, { c_enum: STATUS.running, c_enum_n: null }),
  row(65, { c_enum_n: null }),
  row(66, { c_enum_arr: [STATUS.running, STATUS.failed] }),
  row(67, { c_enum_arr: [] as readonly string[] }),
  row(68, { c_enum_arr: [STATUS.done] }),
];

function buildStaticSchema(): StaticSchema {
  const idField: StaticField = {
    name: 'id',
    column: 'id',
    type: 'Int',
    nativeType: null,
    enumName: null,
    isList: false,
    isRequired: true,
    isId: true,
    isUnique: false,
    isUpdatedAt: false,
    isForeignKey: false,
  };
  const fields: StaticField[] = [
    idField,
    ...COLUMNS.map((c): StaticField => ({
      name: c.name,
      column: c.name,
      type: 'Unknown',
      nativeType: null,
      enumName: c.enumName ?? null,
      isList: c.ddlType.endsWith('[]'),
      isRequired: !c.nullable,
      isId: false,
      isUnique: false,
      isUpdatedAt: false,
      isForeignKey: false,
    })),
  ];
  return {
    formatVersion: SCHEMA_FORMAT_VERSION,
    enums: [{ name: ENUM_NAME, dbName: ENUM_TYPE, values: [...ENUM_VALUES] }],
    models: [
      {
        model: 'Fixture',
        table: TABLE,
        namespace: 'public',
        fields,
        relations: [],
        primaryKey: ['id'],
        uniques: [],
      },
    ],
  };
}

export async function resolveFixtureModel(pool: Pool): Promise<ResolvedModel> {
  const resolved = await new PgCatalogSchemaProvider(buildStaticSchema(), pool).resolve();
  return resolved.byModel.get('Fixture')!;
}

export async function createFixture(pool: Pool): Promise<void> {
  const cols = COLUMNS.map((c) => `"${c.name}" ${c.ddlType}${c.nullable ? '' : ' NOT NULL'}`).join(
    ',\n    ',
  );
  await pool.query(`DROP TABLE IF EXISTS "${TABLE}"`);
  await pool.query(`DROP TYPE IF EXISTS "${ENUM_TYPE}" CASCADE`);
  await pool.query(
    `CREATE TYPE "${ENUM_TYPE}" AS ENUM (${ENUM_VALUES.map((v) => `'${v}'`).join(', ')})`,
  );
  await pool.query(`
    CREATE TABLE "${TABLE}" (
      id integer PRIMARY KEY,
      ${cols}
    )
  `);

  const model = await resolveFixtureModel(pool);

  for (const r of ROWS) {
    const assignments: string[] = [];
    const values: string[] = [];
    for (const [key, value] of Object.entries(r)) {
      if (key === 'id') continue;
      const field = model.byColumn.get(key)!;
      assignments.push(`"${key}"`);
      const isEnum = field.enumName !== null;
      if (value === null) {
        values.push('NULL');
      } else if (field.elementTypeOid !== null) {
        const literal = formatArrayLiteral(
          field.elementTypeOid,
          value as readonly unknown[],
          isEnum,
        );
        const elemType = isEnum ? `"${field.elementTypeName}"` : sqlArrayType(field.elementTypeOid);
        values.push(`'${literal.replace(/'/g, "''")}'::${elemType}[]`);
      } else {
        const text = formatParamText(field.typeOid, value, isEnum);
        const scalarType = isEnum ? `"${field.typeName}"` : sqlScalarType(field.typeOid);
        values.push(`'${text.replace(/'/g, "''")}'::${scalarType}`);
      }
    }
    await pool.query(
      `INSERT INTO "${TABLE}" (id, ${assignments.join(', ')}) VALUES ($1, ${values.join(', ')})`,
      [r.id],
    );
  }
}

export async function dropFixture(pool: Pool): Promise<void> {
  await pool.query(`DROP TABLE IF EXISTS "${TABLE}"`);
  await pool.query(`DROP TYPE IF EXISTS "${ENUM_TYPE}" CASCADE`);
}

// Mirrors compare.ts's `sqlTypeName`, kept separate so the fixture's INSERT casts don't depend on
// a function whose own correctness this suite is trying to prove.
function sqlScalarType(oid: number): string {
  const model = SCALAR_OID_TO_SQL.get(oid);
  if (!model) throw new Error(`fixture: no SQL type name for oid ${oid}`);
  return model;
}
function sqlArrayType(oid: number): string {
  return sqlScalarType(oid);
}

const SCALAR_OID_TO_SQL = new Map<number, string>([
  [16, 'boolean'],
  [20, 'int8'],
  [21, 'int2'],
  [23, 'int4'],
  [25, 'text'],
  [700, 'float4'],
  [701, 'float8'],
  [1043, 'text'],
  [1042, 'text'],
  [1082, 'date'],
  [1114, 'timestamp'],
  [1184, 'timestamptz'],
  [1700, 'numeric'],
  [2950, 'uuid'],
  [114, 'jsonb'],
  [3802, 'jsonb'],
]);
