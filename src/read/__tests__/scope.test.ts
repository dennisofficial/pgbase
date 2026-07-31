import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPool } from '../../schema/test-support.js';
import { applyPlan } from '../apply.js';
import { scopeRead } from '../scope.js';
import { DEFAULT_READ_LIMITS, ReadValidationError, type ReadArgs } from '../types.js';
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

describe('scopeRead — _count is scoped, not just policy-checked', () => {
  it("the `true` shorthand carries the counted model's RLS", async () => {
    const ctx = await buildContext(pool, REGISTRY_VISIBLE_SETTINGS);
    const { args } = scopeRead({ include: { _count: { select: { tasks: true } } } }, 'Job', ctx);
    const count = (args.include as Record<string, unknown>)['_count'] as {
      select: Record<string, unknown>;
    };
    expect(count.select['tasks']).toEqual({ where: { AND: [{ orgId: ORG_1 }, {}] } });
  });

  it('rejects a _count reaching a model with no client-accessible policy', async () => {
    const ctx = await buildContext(pool, REGISTRY_HIDDEN_SETTINGS);
    expect(() =>
      scopeRead({ include: { _count: { select: { settings: true } } } }, 'Job', ctx),
    ).toThrow(ReadValidationError);
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

// ─────────────────────────────────────────────────────────────────────────────
// Server profile. The RLS predicate is identical to the client profile's; everything the client
// profile does to protect itself from hostile args is gone.
// ─────────────────────────────────────────────────────────────────────────────

async function serverContext() {
  return buildContext(
    pool,
    REGISTRY_VISIBLE_SETTINGS,
    { orgId: ORG_1 },
    DEFAULT_READ_LIMITS,
    'server',
  );
}

describe('scopeRead — server profile still injects RLS everywhere', () => {
  it('ANDs the root RLS in, exactly as the client profile does', async () => {
    const args = { where: { priority: 1 } } satisfies ReadArgs;
    const server = scopeRead(args, 'Job', await serverContext());
    const client = scopeRead(args, 'Job', await buildContext(pool, REGISTRY_VISIBLE_SETTINGS));
    expect(server.args.where).toEqual({ AND: [{ orgId: ORG_1 }, { priority: 1 }] });
    expect(server.args.where).toEqual(client.args.where);
  });

  it("injects the target model's RLS into an included relation", async () => {
    const { args } = scopeRead(
      { include: { tasks: { where: { done: true } } } },
      'Job',
      await serverContext(),
    );
    expect(includeOf(args, 'tasks').where).toEqual({ AND: [{ orgId: ORG_1 }, { done: true }] });
  });

  it('injects RLS into a relation reached through select, without rewriting select to include', async () => {
    const { args } = scopeRead({ select: { id: true, tasks: true } }, 'Job', await serverContext());
    expect(args.include).toBeUndefined();
    const select = args.select as Record<string, unknown>;
    expect(select['id']).toBe(true);
    expect((select['tasks'] as ReadArgs).where).toEqual({ AND: [{ orgId: ORG_1 }, {}] });
  });

  it('injects RLS into a _count over a relation', async () => {
    const { args } = scopeRead(
      { include: { _count: { select: { tasks: true } } } },
      'Job',
      await serverContext(),
    );
    const count = (args.include as Record<string, unknown>)['_count'] as {
      select: Record<string, unknown>;
    };
    expect(count.select['tasks']).toEqual({ where: { AND: [{ orgId: ORG_1 }, {}] } });
  });

  it('still refuses a model with no client-accessible policy', async () => {
    const ctx = await buildContext(
      pool,
      REGISTRY_HIDDEN_SETTINGS,
      { orgId: ORG_1 },
      DEFAULT_READ_LIMITS,
      'server',
    );
    expect(() => scopeRead({ include: { settings: true } }, 'Job', ctx)).toThrow(
      ReadValidationError,
    );
  });
});

describe('scopeRead — server profile drops the untrusted-input layer', () => {
  it('does not clamp take, and does not impose a default one', async () => {
    const ctx = await serverContext();
    expect(scopeRead({ take: 5000 }, 'Job', ctx).args.take).toBe(5000);
    expect(scopeRead({}, 'Job', ctx).args.take).toBeUndefined();
    // The same args through the client profile are capped at maxRows.
    expect(
      scopeRead({ take: 5000 }, 'Job', await buildContext(pool, REGISTRY_VISIBLE_SETTINGS)).args
        .take,
    ).toBe(DEFAULT_READ_LIMITS.maxRows);
  });

  it('allows filtering, ordering and selecting an omitted column', async () => {
    const ctx = await serverContext();
    // jobPolicy omits `metadata`; the client profile rejects all three of these.
    expect(scopeRead({ where: { metadata: { equals: 1 } } }, 'Job', ctx).args.where).toEqual({
      AND: [{ orgId: ORG_1 }, { metadata: { equals: 1 } }],
    });
    expect(scopeRead({ orderBy: { metadata: 'asc' } }, 'Job', ctx).args.orderBy).toEqual({
      metadata: 'asc',
    });
    expect(
      (
        scopeRead({ select: { metadata: true } }, 'Job', ctx).args.select as Record<string, unknown>
      )['metadata'],
    ).toBe(true);
  });

  it('returns a pass-through plan, so omitted columns survive to the caller', async () => {
    const { plan } = scopeRead({}, 'Job', await serverContext());
    const row = { id: 'j1', orgId: ORG_1, metadata: { secret: true } };
    expect(applyPlan(plan, [row])).toEqual([row]);
    // The client profile's plan strips both omitted fields.
    const client = scopeRead({}, 'Job', await buildContext(pool, REGISTRY_VISIBLE_SETTINGS));
    expect(applyPlan(client.plan, [row])).toEqual([{ id: 'j1' }]);
  });
});
