import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPool } from '../../schema/test-support.js';
import { normalizeClientWhere } from '../filterable.js';
import { probe } from '../sentinel.js';
import { AUDIT_LOG_MODEL, JOB_MODEL, MEMBERSHIP_MODEL, resolveFixtureSchema } from './fixtures.js';

let pool: Pool;

beforeAll(async () => {
  pool = createTestPool();
});

afterAll(async () => {
  await pool.end();
});

describe('probe — sentinel classification', () => {
  it('JobSettings.webhookSecret: absent, not filterable, and normalize() rejects filtering on it', async () => {
    const schema = await resolveFixtureSchema(pool);
    const jobSettings = schema.byModel.get('JobSettings')!;

    const result = probe(jobSettings, (row: { jobId: string; concurrency: number }) => ({
      jobId: row.jobId,
      concurrency: row.concurrency,
    }));

    expect(result.exposure.get('webhookSecret')).toBe('absent');
    expect(result.filterable.has('webhookSecret')).toBe(false);
    expect(result.filterable.has('jobId')).toBe(true);
    expect(result.filterable.has('concurrency')).toBe(true);

    // The load-bearing assertion: the filter oracle is the leak, not the returned value.
    expect(() =>
      normalizeClientWhere({ webhookSecret: { startsWith: 'a' } }, jobSettings, result),
    ).toThrow(/webhookSecret/);
  });

  it('a concatenated field marks both source columns "derived", not "whole"', async () => {
    const schema = await resolveFixtureSchema(pool);
    const job = schema.byModel.get('Job')!;

    const result = probe(job, (row: { id: string; name: string; status: string }) => ({
      id: row.id,
      summary: `${row.name} (${row.status})`,
    }));

    expect(result.exposure.get('name')).toBe('derived');
    expect(result.exposure.get('status')).toBe('derived');
    expect(result.filterable.has('name')).toBe(false);
    expect(result.filterable.has('status')).toBe(false);
    expect(result.exposure.get('id')).toBe('whole');
    expect(result.filterable.has('id')).toBe(true);
  });

  it('rejects a transform that branches on a row value, naming the model', async () => {
    const schema = await resolveFixtureSchema(pool);
    const job = schema.byModel.get('Job')!;

    // Coupled to SentinelGenerator's `run * 10_000 + id` scheme: run-1 priority sentinels stay
    // under 15_000, run-2 sentinels are always over it, so this branch reliably diverges.
    const dataDependent = (row: { priority: number }) =>
      row.priority > 15_000 ? { big: true } : { small: true };

    expect(() => probe(job, dataDependent)).toThrow(/Job/);
    expect(() => probe(job, dataDependent)).toThrow(/pure and total|shape differed/i);
  });

  it('a transform that throws on the synthetic row produces a named, non-raw error', async () => {
    const schema = await resolveFixtureSchema(pool);
    const job = schema.byModel.get('Job')!;

    const throwing = (row: { name: string }) => {
      throw new TypeError(`boom: ${row.name.toUpperCase()}`);
    };

    expect(() => probe(job, throwing)).toThrow(/Job/);
    expect(() => probe(job, throwing)).not.toThrow(TypeError);
  });

  it('boolean columns: a passed-through value is "whole", an ignored one is "absent"', async () => {
    const schema = await resolveFixtureSchema(pool);
    const task = schema.byModel.get('Task')!;

    const result = probe(task, (row: { id: string; done: boolean }) => ({
      id: row.id,
      done: row.done,
    }));

    expect(result.exposure.get('done')).toBe('whole');
    expect(result.filterable.has('done')).toBe(true);
  });

  it('boolean columns: a co-varying but non-boolean output is "derived", not "whole"', async () => {
    const schema = await resolveFixtureSchema(pool);
    const task = schema.byModel.get('Task')!;

    const result = probe(task, (row: { id: string; done: boolean }) => ({
      id: row.id,
      status: row.done ? 'complete' : 'pending',
    }));

    expect(result.exposure.get('done')).toBe('derived');
    expect(result.filterable.has('done')).toBe(false);
  });

  it('boolean columns: an output that never changes with the value is "absent"', async () => {
    const schema = await resolveFixtureSchema(pool);
    const task = schema.byModel.get('Task')!;

    const result = probe(task, (row: { id: string }) => ({ id: row.id }));

    expect(result.exposure.get('done')).toBe('absent');
    expect(result.filterable.has('done')).toBe(false);
  });

  it('Membership (composite PK) probes cleanly', async () => {
    const schema = await resolveFixtureSchema(pool);
    const membership = schema.byModel.get('Membership')!;

    const result = probe(membership, (row: { orgId: string; userId: string; role: string }) => ({
      orgId: row.orgId,
      userId: row.userId,
      role: row.role,
    }));

    expect(result.exposure.get('orgId')).toBe('whole');
    expect(result.exposure.get('userId')).toBe('whole');
    expect(result.exposure.get('role')).toBe('whole');
    expect(result.filterable).toEqual(new Set(['orgId', 'userId', 'role']));
    expect(MEMBERSHIP_MODEL.primaryKey).toEqual(['org_id', 'user_id']);
  });

  it('AuditLog (no tenant column) probes cleanly', async () => {
    const schema = await resolveFixtureSchema(pool);
    const auditLog = schema.byModel.get('AuditLog')!;

    const result = probe(
      auditLog,
      (row: { id: bigint; action: string; actorId: string | null; at: bigint }) => ({
        id: row.id,
        action: row.action,
        at: row.at,
      }),
    );

    expect(result.exposure.get('id')).toBe('whole');
    expect(result.exposure.get('action')).toBe('whole');
    expect(result.exposure.get('actorId')).toBe('absent');
    expect(result.exposure.get('at')).toBe('whole');
    expect(AUDIT_LOG_MODEL.primaryKey).toEqual(['id']);
  });

  it('every column of the model appears in `exposure`, even fully-omitted ones', async () => {
    const schema = await resolveFixtureSchema(pool);
    const job = schema.byModel.get('Job')!;

    const result = probe(job, () => ({}));

    expect(result.exposure.size).toBe(JOB_MODEL.fields.length);
    for (const f of JOB_MODEL.fields) {
      expect(result.exposure.get(f.name)).toBe('absent');
    }
    expect(result.filterable.size).toBe(0);
  });
});

describe('probe — wire serializability', () => {
  it('rejects a transform returning a Map, which JSON.stringify silently empties', async () => {
    const schema = await resolveFixtureSchema(pool);
    const job = schema.byModel.get('Job')!;
    expect(() =>
      probe(job, (row: { name: string }) => ({ tags: new Map([['a', row.name]]) })),
    ).toThrow(/non-serializable|JSON/i);
  });

  it('rejects a Set for the same reason', async () => {
    const schema = await resolveFixtureSchema(pool);
    const job = schema.byModel.get('Job')!;
    expect(() => probe(job, (row: { name: string }) => ({ s: new Set([row.name]) }))).toThrow(
      /non-serializable|JSON/i,
    );
  });
});
