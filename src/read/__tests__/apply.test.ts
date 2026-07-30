import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPool } from '../../schema/test-support.js';
import { applyPlan } from '../apply.js';
import { scopeRead } from '../scope.js';
import { buildContext, REGISTRY_VISIBLE_SETTINGS } from './policies.js';

let pool: Pool;

beforeAll(() => {
  pool = createTestPool();
});

afterAll(async () => {
  await pool.end();
});

describe('applyPlan — nested one-to-many, one-to-one, and null relations', () => {
  it('strips hidden fields at every level and keys relations by their request field name', async () => {
    const ctx = await buildContext(pool, REGISTRY_VISIBLE_SETTINGS);
    const { plan } = scopeRead(
      { include: { settings: true, tasks: true } },
      'Job',
      ctx,
    );

    const rawJob = {
      id: 'job-1',
      orgId: ctx.claims.orgId,
      name: 'Nightly build',
      status: 'QUEUED',
      priority: 1,
      metadata: {},
      settings: { jobId: 'job-1', concurrency: 3, webhookSecret: 'shh' },
      tasks: [
        { id: 't1', orgId: ctx.claims.orgId, jobId: 'job-1', title: 'A', done: true },
        { id: 't2', orgId: ctx.claims.orgId, jobId: 'job-1', title: 'B', done: false },
      ],
    };

    expect(applyPlan(plan, rawJob)).toEqual({
      id: 'job-1',
      name: 'Nightly build',
      status: 'QUEUED',
      priority: 1,
      settings: { jobId: 'job-1', concurrency: 3 },
      tasks: [
        { id: 't1', title: 'A', done: true },
        { id: 't2', title: 'B', done: false },
      ],
    });
  });

  it('a null to-one relation stays null, not an empty transformed object', async () => {
    const ctx = await buildContext(pool, REGISTRY_VISIBLE_SETTINGS);
    const { plan } = scopeRead({ include: { settings: true } }, 'Job', ctx);

    const rawJob = {
      id: 'job-2',
      orgId: ctx.claims.orgId,
      name: 'No settings yet',
      status: 'QUEUED',
      priority: 0,
      settings: null,
    };

    expect(applyPlan(plan, rawJob)).toEqual({
      id: 'job-2',
      name: 'No settings yet',
      status: 'QUEUED',
      priority: 0,
      settings: null,
    });
  });

  it('an empty to-many relation stays an empty array', async () => {
    const ctx = await buildContext(pool, REGISTRY_VISIBLE_SETTINGS);
    const { plan } = scopeRead({ include: { tasks: true } }, 'Job', ctx);

    const rawJob = {
      id: 'job-3',
      orgId: ctx.claims.orgId,
      name: 'Empty',
      status: 'QUEUED',
      priority: 0,
      tasks: [],
    };

    expect(applyPlan(plan, rawJob)).toEqual({
      id: 'job-3',
      name: 'Empty',
      status: 'QUEUED',
      priority: 0,
      tasks: [],
    });
  });

  it('maps a top-level array (findMany) row by row', async () => {
    const ctx = await buildContext(pool, REGISTRY_VISIBLE_SETTINGS);
    const { plan } = scopeRead({}, 'Job', ctx);

    const rows = [
      { id: 'a', orgId: ctx.claims.orgId, name: 'A', status: 'QUEUED', priority: 0 },
      { id: 'b', orgId: ctx.claims.orgId, name: 'B', status: 'RUNNING', priority: 1 },
    ];

    expect(applyPlan(plan, rows)).toEqual([
      { id: 'a', name: 'A', status: 'QUEUED', priority: 0 },
      { id: 'b', name: 'B', status: 'RUNNING', priority: 1 },
    ]);
  });

  it('a null root result passes through unchanged', async () => {
    const ctx = await buildContext(pool, REGISTRY_VISIBLE_SETTINGS);
    const { plan } = scopeRead({}, 'Job', ctx);
    expect(applyPlan(plan, null)).toBeNull();
  });
});
