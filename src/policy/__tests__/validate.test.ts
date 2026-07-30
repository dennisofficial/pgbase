import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PgCatalogSchemaProvider } from '../../schema/resolver.js';
import { createTestPool } from '../../schema/test-support.js';
import type { StaticModel } from '../../schema/types.js';
import { SCHEMA_FORMAT_VERSION } from '../../version.js';
import { definePolicy } from '../define.js';
import { NO_CLIENT_ACCESS, type PolicyEntry } from '../types.js';
import { validatePolicies } from '../validate.js';
import {
  AUDIT_LOG_MODEL,
  MEMBERSHIP_MODEL,
  field,
  model,
  resolveFixtureSchema,
  resolveOne,
} from './fixtures.js';

let pool: Pool;

beforeAll(async () => {
  pool = createTestPool();
});

afterAll(async () => {
  await pool.end();
});

type Row = Record<string, unknown>;

const jobPolicy = definePolicy<Row, unknown>('Job')({ rls: () => ({}) });
const jobSettingsPolicy = definePolicy<Row, unknown>('JobSettings')({
  omit: ['webhookSecret'],
  rls: () => ({}),
});
const membershipPolicy = definePolicy<Row, unknown>('Membership')({ rls: () => ({}) });
const auditLogPolicy = definePolicy<Row, unknown>('AuditLog')({
  omit: ['action', 'actorId', 'at'],
  rls: () => ({}),
});
const taskPolicy = definePolicy<Row, unknown>('Task')({ rls: () => ({}) });

const FULL_REGISTRY = {
  Job: jobPolicy,
  JobSettings: jobSettingsPolicy,
  Membership: membershipPolicy,
  AuditLog: auditLogPolicy,
  Task: taskPolicy,
};

describe('validatePolicies — registry exhaustiveness', () => {
  it('throws, naming the model, when the schema has no registry entry', async () => {
    const schema = await resolveFixtureSchema(pool);
    const { AuditLog: _omit, ...incomplete } = FULL_REGISTRY;
    void _omit;

    expect(() => validatePolicies(schema, incomplete)).toThrow(/AuditLog/);
  });

  it('throws, naming the model, when the registry names a model outside the schema', async () => {
    const schema = await resolveFixtureSchema(pool);
    const withTypo = { ...FULL_REGISTRY, JobbSettings: jobSettingsPolicy };

    expect(() => validatePolicies(schema, withTypo)).toThrow(/JobbSettings/);
  });

  it('NO_CLIENT_ACCESS satisfies the registry and is excluded from the result, unprobed', async () => {
    const schema = await resolveFixtureSchema(pool);
    // `satisfies`, not a bare literal: an object-literal property assigned from a `unique symbol`
    // constant widens to plain `symbol` without a contextual type, which no longer matches
    // `NoClientAccess`.
    const registry = {
      Job: jobPolicy,
      JobSettings: jobSettingsPolicy,
      Membership: membershipPolicy,
      AuditLog: auditLogPolicy,
      Task: NO_CLIENT_ACCESS,
    } satisfies Record<string, PolicyEntry<any, any, any>>;

    const result = validatePolicies(schema, registry);

    expect(result.has('Task')).toBe(false);
    expect(result.has('Job')).toBe(true);
  });
});

describe('validatePolicies — omit naming an unknown field fails at boot', () => {
  it('throws, naming the model and field', async () => {
    const schema = await resolveFixtureSchema(pool);
    const registry = {
      ...FULL_REGISTRY,
      Job: definePolicy<Row, unknown>('Job')({ omit: ['doesNotExist'], rls: () => ({}) }),
    };

    expect(() => validatePolicies(schema, registry)).toThrow(/Job.*doesNotExist/is);
  });
});

describe('validatePolicies — omit must not hide every column', () => {
  it('throws when omit lists every field on the model', async () => {
    const schema = await resolveFixtureSchema(pool);
    const registry = {
      ...FULL_REGISTRY,
      Task: definePolicy<Row, unknown>('Task')({
        omit: ['id', 'orgId', 'jobId', 'title', 'done', 'blockedBy', 'createdAt'],
        rls: () => ({}),
      }),
    };

    expect(() => validatePolicies(schema, registry)).toThrow(/Task.*nothing is exposed/is);
  });
});

describe('validatePolicies — REPLICA IDENTITY vs filterable-not-subset-of-PK', () => {
  it('fires on AuditLog (not FULL) when a non-PK column is left visible', async () => {
    const schema = await resolveOne(pool, AUDIT_LOG_MODEL);
    const registry = {
      AuditLog: definePolicy<Row, unknown>('AuditLog')({
        omit: ['actorId', 'at'],
        rls: () => ({}),
      }),
    };

    expect(() => validatePolicies(schema, registry)).toThrow(/AuditLog.*action/s);
    expect(() => validatePolicies(schema, registry)).toThrow(/REPLICA IDENTITY/);
  });

  it('does not fire on Membership (FULL) even though `role` is outside the composite PK', async () => {
    const schema = await resolveOne(pool, MEMBERSHIP_MODEL);
    const registry = {
      Membership: definePolicy<Row, unknown>('Membership')({ rls: () => ({}) }),
    };

    const result = validatePolicies(schema, registry);
    expect(result.get('Membership')?.probeResult.filterable.has('role')).toBe(true);
  });

  it('does not fire when filterable stays within the primary key, even off FULL', async () => {
    const schema = await resolveOne(pool, AUDIT_LOG_MODEL);
    const registry = {
      AuditLog: definePolicy<Row, unknown>('AuditLog')({
        omit: ['action', 'actorId', 'at'],
        rls: () => ({}),
      }),
    };

    const result = validatePolicies(schema, registry);
    expect(result.get('AuditLog')?.probeResult.filterable).toEqual(new Set(['id']));
  });
});

describe('validatePolicies — §7.3 combination cannot boot', () => {
  const TABLE = '_pgbase_policy_test_full_pluslist';

  afterEach(async () => {
    await pool.query(`DROP PUBLICATION IF EXISTS pgbase_policy_test_pub`);
    await pool.query(`DROP TABLE IF EXISTS "${TABLE}"`);
  });

  it('resolve() rejects REPLICA IDENTITY FULL + a publication column list before validatePolicies ever runs', async () => {
    await pool.query(`CREATE TABLE "${TABLE}" (id uuid PRIMARY KEY, secret text NOT NULL)`);
    await pool.query(`ALTER TABLE "${TABLE}" REPLICA IDENTITY FULL`);
    await pool.query(`CREATE PUBLICATION pgbase_policy_test_pub FOR TABLE "${TABLE}" (id)`);

    const staticModel: StaticModel = model({
      model: 'FullPlusList',
      table: TABLE,
      fields: [field('id', 'id', { isId: true }), field('secret', 'secret')],
      primaryKey: ['id'],
    });

    await expect(
      new PgCatalogSchemaProvider(
        { formatVersion: SCHEMA_FORMAT_VERSION, models: [staticModel], enums: [] },
        pool,
        { publication: 'pgbase_policy_test_pub' },
      ).resolve(),
    ).rejects.toThrow(/FullPlusList.*UPDATE.*DELETE/is);

    // The whole point: there is no ResolvedSchema to hand validatePolicies at all.
  });
});
