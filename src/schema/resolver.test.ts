import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SCHEMA_FORMAT_VERSION } from '../version.js';
import { PgCatalogSchemaProvider } from './resolver.js';
import { createTestPool } from './test-support.js';
import type { StaticModel, StaticSchema } from './types.js';

// Well-known, stable Postgres built-in OIDs (pg_type is an initial catalog; these never change).
const OID_TEXT = 25;
const OID_TEXT_ARRAY = 1009;
const OID_NUMERIC = 1700;
const OID_INT8 = 20;
const OID_UUID = 2950;

function schema(models: readonly StaticModel[]): StaticSchema {
  return { formatVersion: SCHEMA_FORMAT_VERSION, models, enums: [] };
}

function model(partial: Partial<StaticModel> & Pick<StaticModel, 'model' | 'table'>): StaticModel {
  return {
    namespace: 'public',
    fields: [],
    relations: [],
    primaryKey: [],
    uniques: [],
    ...partial,
  };
}

function field(
  name: string,
  column: string,
  overrides: Partial<StaticModel['fields'][number]> = {},
): StaticModel['fields'][number] {
  return {
    name,
    column,
    type: 'String',
    nativeType: null,
    enumName: null,
    isList: false,
    isRequired: true,
    isId: false,
    isUnique: false,
    isUpdatedAt: false,
    isForeignKey: false,
    ...overrides,
  };
}

let pool: Pool;

beforeAll(() => {
  pool = createTestPool();
});

afterAll(async () => {
  await pool.end();
});

describe('PgCatalogSchemaProvider — physical resolution', () => {
  it('resolves a composite primary key (Membership) in column order', async () => {
    const staticSchema = schema([
      model({
        model: 'Membership',
        table: 'memberships',
        fields: [
          field('orgId', 'org_id', { isForeignKey: true }),
          field('userId', 'user_id', { isForeignKey: true }),
          field('role', 'role', { type: 'MemberRole', enumName: 'MemberRole' }),
        ],
        primaryKey: ['org_id', 'user_id'],
      }),
    ]);

    const resolved = await new PgCatalogSchemaProvider(staticSchema, pool).resolve();
    const membership = resolved.byModel.get('Membership')!;
    expect(membership.primaryKey).toEqual(['org_id', 'user_id']);
    expect(membership.byColumn.get('org_id')?.typeOid).toBe(OID_UUID);
  });

  it('resolves a primary key that is also a foreign key (JobSettings.jobId)', async () => {
    const staticSchema = schema([
      model({
        model: 'JobSettings',
        table: 'job_settings',
        fields: [
          field('jobId', 'job_id', { isId: true, isForeignKey: true }),
          field('concurrency', 'concurrency', { type: 'Int' }),
        ],
        primaryKey: ['job_id'],
      }),
    ]);

    const resolved = await new PgCatalogSchemaProvider(staticSchema, pool).resolve();
    const jobSettings = resolved.byModel.get('JobSettings')!;
    expect(jobSettings.primaryKey).toEqual(['job_id']);
    const jobId = jobSettings.byColumn.get('job_id')!;
    expect(jobId.isId).toBe(true);
    expect(jobId.isForeignKey).toBe(true);
    expect(jobId.typeOid).toBe(OID_UUID);
  });

  it('round-trips @@map / @map (Job model -> jobs table, createdAt -> created_at)', async () => {
    const staticSchema = schema([
      model({
        model: 'Job',
        table: 'jobs',
        fields: [
          field('id', 'id', { isId: true }),
          field('createdAt', 'created_at', { type: 'DateTime' }),
        ],
        primaryKey: ['id'],
      }),
    ]);

    const resolved = await new PgCatalogSchemaProvider(staticSchema, pool).resolve();
    // byTable is keyed "namespace.table" — the physical name, not the Prisma model name.
    const job = resolved.byTable.get('public.jobs')!;
    expect(job.model).toBe('Job');
    expect(job.byColumn.get('created_at')).toBeDefined();
    expect(job.byColumn.get('createdAt')).toBeUndefined();
  });

  it('resolves Invoice.amount as numeric and Invoice.externalRef as int8, by actual OID', async () => {
    const staticSchema = schema([
      model({
        model: 'Invoice',
        table: 'invoices',
        fields: [
          field('id', 'id', { isId: true }),
          field('amount', 'amount', { type: 'Decimal', nativeType: ['Decimal', ['18', '4']] }),
          field('externalRef', 'external_ref', { type: 'BigInt' }),
        ],
        primaryKey: ['id'],
      }),
    ]);

    const resolved = await new PgCatalogSchemaProvider(staticSchema, pool).resolve();
    const invoice = resolved.byModel.get('Invoice')!;
    const amount = invoice.byColumn.get('amount')!;
    const externalRef = invoice.byColumn.get('external_ref')!;
    expect(amount.typeOid).toBe(OID_NUMERIC);
    expect(amount.typeName).toBe('numeric');
    expect(externalRef.typeOid).toBe(OID_INT8);
    expect(externalRef.typeName).toBe('int8');
  });

  it('resolves Job.labels as a text[] array with a non-null elementTypeOid', async () => {
    const staticSchema = schema([
      model({
        model: 'Job',
        table: 'jobs',
        fields: [
          field('id', 'id', { isId: true }),
          field('labels', 'labels', { type: 'String', isList: true }),
        ],
        primaryKey: ['id'],
      }),
    ]);

    const resolved = await new PgCatalogSchemaProvider(staticSchema, pool).resolve();
    const labels = resolved.byModel.get('Job')!.byColumn.get('labels')!;
    expect(labels.typeOid).toBe(OID_TEXT_ARRAY);
    expect(labels.elementTypeOid).toBe(OID_TEXT);
  });

  it('resolves AuditLog, which has no tenant column, without incident', async () => {
    const staticSchema = schema([
      model({
        model: 'AuditLog',
        table: 'audit_log',
        fields: [
          field('id', 'id', { type: 'BigInt', isId: true }),
          field('action', 'action'),
          field('actorId', 'actor_id', { isRequired: false }),
          field('at', 'at', { type: 'DateTime' }),
        ],
        primaryKey: ['id'],
      }),
    ]);

    const resolved = await new PgCatalogSchemaProvider(staticSchema, pool).resolve();
    const auditLog = resolved.byModel.get('AuditLog')!;
    expect(auditLog.primaryKey).toEqual(['id']);
    expect(auditLog.byColumn.get('id')?.typeOid).toBe(OID_INT8);
    // Default replica identity (PK-only) — the fixture leaves this table off REPLICA IDENTITY
    // FULL on purpose, to prove the degraded Tier B path resolves cleanly.
    expect(auditLog.replicaIdentity).toBe('default');
  });

  it('discovers the _JobToTag implicit m2m join table with both sides correctly attributed', async () => {
    const staticSchema = schema([
      model({
        model: 'Job',
        table: 'jobs',
        fields: [field('id', 'id', { isId: true })],
        primaryKey: ['id'],
        relations: [
          {
            name: 'tags',
            relationName: 'JobToTag',
            targetModel: 'Tag',
            cardinality: 'many',
            fromColumns: [],
            toColumns: [],
            isImplicitManyToMany: true,
          },
        ],
      }),
      model({
        model: 'Tag',
        table: 'tags',
        fields: [field('id', 'id', { isId: true })],
        primaryKey: ['id'],
        relations: [
          {
            name: 'jobs',
            relationName: 'JobToTag',
            targetModel: 'Job',
            cardinality: 'many',
            fromColumns: [],
            toColumns: [],
            isImplicitManyToMany: true,
          },
        ],
      }),
    ]);

    const resolved = await new PgCatalogSchemaProvider(staticSchema, pool).resolve();
    const jobTags = resolved.byModel.get('Job')!.relations.find((r) => r.name === 'tags')!;
    const tagJobs = resolved.byModel.get('Tag')!.relations.find((r) => r.name === 'jobs')!;

    expect(jobTags.joinTable).not.toBeNull();
    expect(jobTags.joinTable).toEqual(tagJobs.joinTable);
    expect(jobTags.joinTable).toMatchObject({
      namespace: 'public',
      table: '_JobToTag',
      modelA: 'Job',
      modelB: 'Tag',
      columnA: 'A',
      columnB: 'B',
    });
  });
});

describe('PgCatalogSchemaProvider — boot validation', () => {
  it('throws, naming the model and table, when no physical table matches', async () => {
    const staticSchema = schema([
      model({
        model: 'Nonexistent',
        table: 'this_table_does_not_exist',
        fields: [field('id', 'id', { isId: true })],
        primaryKey: ['id'],
      }),
    ]);

    await expect(new PgCatalogSchemaProvider(staticSchema, pool).resolve()).rejects.toThrow(
      /Nonexistent.*this_table_does_not_exist/s,
    );
  });

  it('throws, naming the model/column, when a static column has no physical column', async () => {
    const staticSchema = schema([
      model({
        model: 'Job',
        table: 'jobs',
        fields: [field('id', 'id', { isId: true }), field('doesNotExist', 'does_not_exist_column')],
        primaryKey: ['id'],
      }),
    ]);

    await expect(new PgCatalogSchemaProvider(staticSchema, pool).resolve()).rejects.toThrow(
      /Job.*doesNotExist.*does_not_exist_column/s,
    );
  });

  it('throws when a model has an empty primary key', async () => {
    const staticSchema = schema([
      model({
        model: 'Job',
        table: 'jobs',
        fields: [field('id', 'id')],
        primaryKey: [],
      }),
    ]);

    await expect(new PgCatalogSchemaProvider(staticSchema, pool).resolve()).rejects.toThrow(
      /Job.*no primary key/is,
    );
  });

  it('throws when the generated schema version does not match the running package', async () => {
    const staticSchema: StaticSchema = {
      ...schema([
        model({
          model: 'Job',
          table: 'jobs',
          fields: [field('id', 'id', { isId: true })],
          primaryKey: ['id'],
        }),
      ]),
      formatVersion: 999,
    };

    await expect(new PgCatalogSchemaProvider(staticSchema, pool).resolve()).rejects.toThrow(
      /format v999/,
    );
  });

  describe('REPLICA IDENTITY FULL + publication column list', () => {
    const TABLE = '_pgbase_test_full_pluslist';

    afterEach(async () => {
      await pool.query(`DROP PUBLICATION IF EXISTS pgbase_test_pub`);
      await pool.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    });

    it('throws, blaming the combination, rather than allowing a boot that blocks all writes', async () => {
      await pool.query(`CREATE TABLE "${TABLE}" (id uuid PRIMARY KEY, secret text NOT NULL)`);
      await pool.query(`ALTER TABLE "${TABLE}" REPLICA IDENTITY FULL`);
      await pool.query(`CREATE PUBLICATION pgbase_test_pub FOR TABLE "${TABLE}" (id)`);

      const staticSchema = schema([
        model({
          model: 'FullPlusList',
          table: TABLE,
          fields: [field('id', 'id', { isId: true }), field('secret', 'secret')],
          primaryKey: ['id'],
        }),
      ]);

      await expect(
        new PgCatalogSchemaProvider(staticSchema, pool, {
          publication: 'pgbase_test_pub',
        }).resolve(),
      ).rejects.toThrow(/FullPlusList.*UPDATE.*DELETE/is);
    });

    it('ignores a column list belonging to a publication pgbase does not decode from', async () => {
      // Same physical state as above, but pgbase is pointed at a different publication. The
      // restriction is real and still blocks writes — it's just not this publication's business
      // to report. Mis-attributing it would make the REPLICA-IDENTITY-FULL-plus-column-list
      // check fire on unrelated tables in any database running a second replication consumer.
      await pool.query(`CREATE TABLE "${TABLE}" (id uuid PRIMARY KEY, secret text NOT NULL)`);
      await pool.query(`ALTER TABLE "${TABLE}" REPLICA IDENTITY FULL`);
      await pool.query(`CREATE PUBLICATION pgbase_test_pub FOR TABLE "${TABLE}" (id)`);

      const staticSchema = schema([
        model({
          model: 'FullPlusList',
          table: TABLE,
          fields: [field('id', 'id', { isId: true }), field('secret', 'secret')],
          primaryKey: ['id'],
        }),
      ]);

      const resolved = await new PgCatalogSchemaProvider(staticSchema, pool, {
        publication: 'some_other_publication',
      }).resolve();

      expect(resolved.publication).toBe('some_other_publication');
      expect(resolved.byModel.get('FullPlusList')?.publicationColumns).toBeNull();
    });

    it('treats FOR ALL TABLES membership as unrestricted', async () => {
      // A FOR ALL TABLES publication has no pg_publication_rel row at all, so a naive join would
      // report "not published" for every table in the database, and the check above would never
      // fire.
      await pool.query(`CREATE TABLE "${TABLE}" (id uuid PRIMARY KEY, secret text NOT NULL)`);
      await pool.query(`ALTER TABLE "${TABLE}" REPLICA IDENTITY FULL`);
      await pool.query(`CREATE PUBLICATION pgbase_test_pub FOR ALL TABLES`);

      const staticSchema = schema([
        model({
          model: 'FullPlusList',
          table: TABLE,
          fields: [field('id', 'id', { isId: true }), field('secret', 'secret')],
          primaryKey: ['id'],
        }),
      ]);

      const resolved = await new PgCatalogSchemaProvider(staticSchema, pool, {
        publication: 'pgbase_test_pub',
      }).resolve();

      expect(resolved.byModel.get('FullPlusList')?.publicationColumns).toBeNull();
      expect(resolved.byModel.get('FullPlusList')?.replicaIdentity).toBe('full');
    });
  });
});
