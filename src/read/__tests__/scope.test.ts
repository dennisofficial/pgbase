import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPool } from '../../schema/test-support.js';
import { scopeRead } from '../scope.js';
import { ReadValidationError, type ReadArgs } from '../types.js';
import {
  ORG_1,
  REGISTRY_HIDDEN_SETTINGS,
  REGISTRY_VISIBLE_SETTINGS,
  buildContext,
} from './policies.js';

let pool: Pool;

beforeAll(() => {
  pool = createTestPool();
});

afterAll(async () => {
  await pool.end();
});

function includeOf(args: ReadArgs, key: string): ReadArgs {
  return (args.include as Record<string, unknown>)[key] as ReadArgs;
}

describe('scopeRead — hidden models are unreachable', () => {
  it('include: { settings: true } reaching JobSettings (NO_CLIENT_ACCESS) throws, naming the path', async () => {
    const ctx = await buildContext(pool, REGISTRY_HIDDEN_SETTINGS);
    expect(() => scopeRead({ include: { settings: true } }, 'Job', ctx)).toThrow(
      ReadValidationError,
    );
    expect(() => scopeRead({ include: { settings: true } }, 'Job', ctx)).toThrow(/settings/);
  });
});

describe('scopeRead — RLS injected at every relation level', () => {
  it("a nested where is ANDed with the target model's RLS, RLS outermost", async () => {
    const ctx = await buildContext(pool, REGISTRY_VISIBLE_SETTINGS);
    const { args } = scopeRead({ include: { tasks: { where: { done: true } } } }, 'Job', ctx);
    const tasksArgs = includeOf(args, 'tasks');
    expect(tasksArgs.where).toEqual({ AND: [{ orgId: ORG_1 }, { done: true }] });
  });

  it("the `true` shorthand still gets a `where` slot carrying the target's RLS", async () => {
    const ctx = await buildContext(pool, REGISTRY_VISIBLE_SETTINGS);
    const { args } = scopeRead({ include: { tasks: true } }, 'Job', ctx);
    const tasksArgs = includeOf(args, 'tasks');
    expect(tasksArgs.where).toEqual({ AND: [{ orgId: ORG_1 }, {}] });
  });

  it('three levels deep (Org → Job → Task), each level gets its own RLS', async () => {
    const ctx = await buildContext(pool, REGISTRY_VISIBLE_SETTINGS);
    const { args } = scopeRead({ include: { jobs: { include: { tasks: true } } } }, 'Org', ctx);

    expect(args.where).toEqual({ AND: [{ id: ORG_1 }, {}] });

    const jobsArgs = includeOf(args, 'jobs');
    expect(jobsArgs.where).toEqual({ AND: [{ orgId: ORG_1 }, {}] });

    const tasksArgs = includeOf(jobsArgs, 'tasks');
    expect(tasksArgs.where).toEqual({ AND: [{ orgId: ORG_1 }, {}] });
  });
});

describe('scopeRead — orderBy validated against filterable', () => {
  it('throws on a non-exposed field', async () => {
    const ctx = await buildContext(pool, REGISTRY_VISIBLE_SETTINGS);
    expect(() => scopeRead({ orderBy: { metadata: 'asc' } }, 'Job', ctx)).toThrow(
      ReadValidationError,
    );
    expect(() => scopeRead({ orderBy: { metadata: 'asc' } }, 'Job', ctx)).toThrow(/metadata/);
  });

  it('passes on an exposed, filterable field', async () => {
    const ctx = await buildContext(pool, REGISTRY_VISIBLE_SETTINGS);
    const { args } = scopeRead({ orderBy: { priority: 'asc' } }, 'Job', ctx);
    expect(args.orderBy).toEqual({ priority: 'asc' });
  });
});

describe('scopeRead — select cannot leak a field the transform omits', () => {
  it('select: { webhookSecret: true } throws even though JobSettings itself is reachable', async () => {
    const ctx = await buildContext(pool, REGISTRY_VISIBLE_SETTINGS);
    expect(() =>
      scopeRead({ select: { jobId: true, webhookSecret: true } }, 'JobSettings', ctx),
    ).toThrow(/webhookSecret/);
  });
});

describe('scopeRead — take clamped at every level', () => {
  it('clamps an oversized take at the root, and inside a nested include', async () => {
    const ctx = await buildContext(pool, REGISTRY_VISIBLE_SETTINGS, undefined, {
      maxRows: 5,
      statementTimeoutMs: 5_000,
    });
    const { args } = scopeRead({ take: 1_000, include: { tasks: { take: 1_000 } } }, 'Job', ctx);
    expect(args.take).toBe(5);
    expect(includeOf(args, 'tasks').take).toBe(5);
  });

  it('a missing nested take defaults to maxRows', async () => {
    const ctx = await buildContext(pool, REGISTRY_VISIBLE_SETTINGS, undefined, {
      maxRows: 5,
      statementTimeoutMs: 5_000,
    });
    const { args } = scopeRead({ include: { tasks: true } }, 'Job', ctx);
    expect(includeOf(args, 'tasks').take).toBe(5);
  });

  it('rejects a non-positive take', async () => {
    const ctx = await buildContext(pool, REGISTRY_VISIBLE_SETTINGS);
    expect(() => scopeRead({ take: 0 }, 'Job', ctx)).toThrow(ReadValidationError);
    expect(() => scopeRead({ take: -1 }, 'Job', ctx)).toThrow(ReadValidationError);
  });
});

describe('scopeRead — cursor validated against filterable', () => {
  it('throws when cursoring on a non-filterable field', async () => {
    const ctx = await buildContext(pool, REGISTRY_VISIBLE_SETTINGS);
    expect(() => scopeRead({ cursor: { metadata: 'x' } }, 'Job', ctx)).toThrow(ReadValidationError);
    expect(() => scopeRead({ cursor: { metadata: 'x' } }, 'Job', ctx)).toThrow(/metadata/);
  });

  it('passes when cursoring on a filterable field', async () => {
    const ctx = await buildContext(pool, REGISTRY_VISIBLE_SETTINGS);
    const { args } = scopeRead({ cursor: { id: 'x' } }, 'Job', ctx);
    expect(args.cursor).toEqual({ id: 'x' });
  });
});

describe('scopeRead — unknown relation field', () => {
  it('throws naming the path', async () => {
    const ctx = await buildContext(pool, REGISTRY_VISIBLE_SETTINGS);
    expect(() => scopeRead({ include: { bogus: true } }, 'Job', ctx)).toThrow(ReadValidationError);
    expect(() => scopeRead({ include: { bogus: true } }, 'Job', ctx)).toThrow(/bogus/);
  });
});

describe('scopeRead — select and include are mutually exclusive at a level', () => {
  it('throws when both are set', async () => {
    const ctx = await buildContext(pool, REGISTRY_VISIBLE_SETTINGS);
    expect(() => scopeRead({ select: { id: true }, include: { tasks: true } }, 'Job', ctx)).toThrow(
      ReadValidationError,
    );
  });
});
