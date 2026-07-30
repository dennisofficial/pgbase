import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPool } from '../../schema/test-support.js';
import { definePolicy } from '../define.js';
import { buildProjector } from '../project.js';
import { resolveFixtureSchema } from './fixtures.js';

interface AuditLogRow {
  readonly id: bigint;
  readonly action: string;
  readonly actorId: string | null;
  readonly at: Date;
}

interface JobRow {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
}

let pool: Pool;

beforeAll(async () => {
  pool = createTestPool();
});

afterAll(async () => {
  await pool.end();
});

describe('buildProjector', () => {
  it('drops omitted fields and passes the rest through with their native runtime type', async () => {
    const schema = await resolveFixtureSchema(pool);
    const auditLog = schema.byModel.get('AuditLog')!;
    const policy = definePolicy<AuditLogRow, unknown>('AuditLog')({
      omit: ['action', 'actorId'],
      rls: () => ({}),
    });
    const project = buildProjector(auditLog, policy);

    const at = new Date('2026-01-01T00:00:00Z');
    const view = project({ id: 10n, action: 'created', actorId: 'u1', at }) as Record<
      string,
      unknown
    >;

    expect(view).toEqual({ id: 10n, at });
    // Not stringified here — the view type promises Row's own field types; wire encoding is a
    // transport-boundary concern (read/wire.ts), not this function's.
    expect(view.id).toBe(10n);
    expect(view.at).toBeInstanceOf(Date);
  });

  it('a null row passes through unchanged', async () => {
    const schema = await resolveFixtureSchema(pool);
    const job = schema.byModel.get('Job')!;
    const policy = definePolicy<JobRow, unknown>('Job')({ rls: () => ({}) });
    const project = buildProjector(job, policy);

    expect(project(null)).toBeNull();
  });

  it('a field absent from the raw row is simply not added to the view', async () => {
    const schema = await resolveFixtureSchema(pool);
    const job = schema.byModel.get('Job')!;
    const policy = definePolicy<JobRow, unknown>('Job')({ rls: () => ({}) });
    const project = buildProjector(job, policy);

    expect(project({ id: 'x' })).toEqual({ id: 'x' });
  });
});
