import type { Pool } from 'pg';
import { ENUM_NAME, ENUM_VALUES } from '../../query/__tests__/differential-fixture.js';
import { formatArrayLiteral, formatParamText, sqlTypeName } from '../../query/compare.js';
import { PgCatalogSchemaProvider } from '../../schema/resolver.js';
import type { ResolvedModel, StaticField, StaticSchema } from '../../schema/types.js';
import { SCHEMA_FORMAT_VERSION } from '../../version.js';

export { ENUM_NAME, ENUM_VALUES };

export const WAL_FIXTURE_TABLE = 'pgbase_wal_fixture';
export const WAL_FIXTURE_ENUM_TYPE = 'pgbase_wal_fixture_status';

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
  { name: 'c_enum', ddlType: `"${WAL_FIXTURE_ENUM_TYPE}"`, nullable: false, enumName: ENUM_NAME },
  { name: 'c_enum_n', ddlType: `"${WAL_FIXTURE_ENUM_TYPE}"`, nullable: true, enumName: ENUM_NAME },
  {
    name: 'c_enum_arr',
    ddlType: `"${WAL_FIXTURE_ENUM_TYPE}"[]`,
    nullable: false,
    enumName: ENUM_NAME,
  },
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
    enums: [{ name: ENUM_NAME, dbName: WAL_FIXTURE_ENUM_TYPE, values: [...ENUM_VALUES] }],
    models: [
      {
        model: 'WalFixture',
        table: WAL_FIXTURE_TABLE,
        namespace: 'public',
        fields,
        relations: [],
        primaryKey: ['id'],
        uniques: [],
      },
    ],
  };
}

export async function resolveWalFixtureModel(pool: Pool): Promise<ResolvedModel> {
  const resolved = await new PgCatalogSchemaProvider(buildStaticSchema(), pool).resolve();
  return resolved.byModel.get('WalFixture')!;
}

export async function createWalFixtureTable(pool: Pool): Promise<ResolvedModel> {
  const cols = COLUMNS.map((c) => `"${c.name}" ${c.ddlType}${c.nullable ? '' : ' NOT NULL'}`).join(
    ',\n    ',
  );
  await pool.query(`DROP TABLE IF EXISTS "${WAL_FIXTURE_TABLE}"`);
  await pool.query(`DROP TYPE IF EXISTS "${WAL_FIXTURE_ENUM_TYPE}" CASCADE`);
  await pool.query(
    `CREATE TYPE "${WAL_FIXTURE_ENUM_TYPE}" AS ENUM (${ENUM_VALUES.map((v) => `'${v}'`).join(', ')})`,
  );
  await pool.query(`
    CREATE TABLE "${WAL_FIXTURE_TABLE}" (
      id integer PRIMARY KEY,
      ${cols}
    )
  `);
  return resolveWalFixtureModel(pool);
}

export async function dropWalFixtureTable(pool: Pool): Promise<void> {
  await pool.query(`DROP TABLE IF EXISTS "${WAL_FIXTURE_TABLE}"`);
  await pool.query(`DROP TYPE IF EXISTS "${WAL_FIXTURE_ENUM_TYPE}" CASCADE`);
}

/** Inserts one row via literal-cast SQL — the same technique `differential-fixture.ts`'s
 * `createFixture` uses, so array/enum/timestamp literals are exercised identically. */
export async function insertWalFixtureRow(
  pool: Pool,
  model: ResolvedModel,
  row: Record<string, unknown>,
): Promise<void> {
  const assignments: string[] = [];
  const values: string[] = [];
  for (const [key, value] of Object.entries(row)) {
    if (key === 'id') continue;
    const field = model.byColumn.get(key);
    if (!field) continue; // columns not present on this row's shape (e.g. c_big_text/c_tag omitted)
    assignments.push(`"${key}"`);
    const isEnum = field.enumValues !== null;
    if (value === null) {
      values.push('NULL');
    } else if (field.elementTypeOid !== null) {
      const literal = formatArrayLiteral(field.elementTypeOid, value as readonly unknown[], isEnum);
      const elemType = isEnum ? `"${field.elementTypeName}"` : sqlTypeName(field.elementTypeOid);
      values.push(`'${literal.replace(/'/g, "''")}'::${elemType}[]`);
    } else {
      const text = formatParamText(field.typeOid, value, isEnum);
      const scalarType = isEnum ? `"${field.typeName}"` : sqlTypeName(field.typeOid);
      values.push(`'${text.replace(/'/g, "''")}'::${scalarType}`);
    }
  }
  await pool.query(
    `INSERT INTO "${WAL_FIXTURE_TABLE}" (id${assignments.length ? ', ' : ''}${assignments.join(', ')}) ` +
      `VALUES ($1${values.length ? ', ' : ''}${values.join(', ')})`,
    [row.id],
  );
}
