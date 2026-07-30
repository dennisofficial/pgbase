import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPool } from '../../schema/test-support.js';
import { definePolicy } from '../define.js';
import { PolicyValidationError } from '../errors.js';
import { computeFilterable, normalizeClientWhere } from '../filterable.js';
import { resolveFixtureSchema } from './fixtures.js';

interface JobSettingsRow {
  readonly jobId: string;
  readonly concurrency: number;
  readonly webhookSecret: string;
}

interface MembershipRow {
  readonly orgId: string;
  readonly userId: string;
  readonly role: string;
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

describe('computeFilterable', () => {
  it('every field not in omit is filterable; omitted fields are not', async () => {
    const schema = await resolveFixtureSchema(pool);
    const jobSettings = schema.byModel.get('JobSettings')!;
    const policy = definePolicy<JobSettingsRow, unknown>('JobSettings')({
      omit: ['webhookSecret'],
      rls: () => ({}),
    });

    const result = computeFilterable(jobSettings, policy);

    expect(result.filterable.has('webhookSecret')).toBe(false);
    expect(result.filterable.has('jobId')).toBe(true);
    expect(result.filterable.has('concurrency')).toBe(true);
  });

  it('the filter-oracle property: an omitted field cannot be filtered on either', async () => {
    const schema = await resolveFixtureSchema(pool);
    const jobSettings = schema.byModel.get('JobSettings')!;
    const policy = definePolicy<JobSettingsRow, unknown>('JobSettings')({
      omit: ['webhookSecret'],
      rls: () => ({}),
    });
    const result = computeFilterable(jobSettings, policy);

    expect(() =>
      normalizeClientWhere({ webhookSecret: { startsWith: 'a' } }, jobSettings, result),
    ).toThrow(/webhookSecret/);
  });

  it('an empty (or absent) omit exposes every field', async () => {
    const schema = await resolveFixtureSchema(pool);
    const membership = schema.byModel.get('Membership')!;
    const policy = definePolicy<MembershipRow, unknown>('Membership')({ rls: () => ({}) });

    const result = computeFilterable(membership, policy);
    expect(result.filterable).toEqual(new Set(['orgId', 'userId', 'role']));
  });

  it('throws, naming the field, when omit names a field that does not exist on the model', async () => {
    const schema = await resolveFixtureSchema(pool);
    const job = schema.byModel.get('Job')!;
    const policy = definePolicy<JobRow, unknown>('Job')({
      omit: ['bogusField' as never],
      rls: () => ({}),
    });

    expect(() => computeFilterable(job, policy)).toThrow(PolicyValidationError);
    expect(() => computeFilterable(job, policy)).toThrow(/bogusField/);
  });
});
