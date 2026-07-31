import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../../examples/api/src/generated/prisma/client.js';
import { AsyncLocalStorageContextStore, ScopeViolationError } from '../../context/index.js';
import { DEFAULT_READ_LIMITS } from '../../read/index.js';
import { ScopedRowNotFoundError } from '../scoped-errors.js';
import { createScopedClient } from '../scoped-extension.js';
import type { Resolved } from '../tokens.js';
import {
  createTestPool,
  createTestPrisma,
  dropFixture,
  resolveTestRuntime,
  seedFixture,
  type Fixture,
  type TestClaims,
} from './real-prisma.js';

let prisma: PrismaClient;
let pool: Pool;
let resolved: Resolved;
let fixture: Fixture;
let store: AsyncLocalStorageContextStore;
let db: any;

async function as<T>(claims: TestClaims, fn: () => T | PromiseLike<T>): Promise<T> {
  return store.run({ principal: claims.userId, claims }, async () => await fn());
}

beforeAll(async () => {
  prisma = createTestPrisma();
  pool = createTestPool();
  resolved = await resolveTestRuntime(pool);
  fixture = await seedFixture(prisma);
  store = new AsyncLocalStorageContextStore();
  db = createScopedClient({
    base: prisma as any,
    resolved,
    contextStore: store,
    limits: DEFAULT_READ_LIMITS,
  });
}, 60_000);

afterAll(async () => {
  if (fixture) await dropFixture(prisma, fixture);
  await prisma.$disconnect();
  await pool.end();
});

beforeEach(async () => {
  await prisma.job.update({
    where: { id: fixture.jobA },
    data: { orgId: fixture.orgA, priority: 5, name: 'job-a' },
  });
  await prisma.job.update({
    where: { id: fixture.jobB },
    data: { orgId: fixture.orgB, priority: 5, name: 'job-b' },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

describe('scoped reads', () => {
  it('filters findMany to the caller scope', async () => {
    const jobs = await as(fixture.claimsA, () => db.job.findMany());
    expect(jobs.map((j: any) => j.id)).toEqual([fixture.jobA]);
  });

  it("scopes an included relation by the relation target's own policy", async () => {
    // crossTask hangs off job A but belongs to org B. Scoping only the parent would return it.
    const [job] = await as(fixture.claimsA, () =>
      db.job.findMany({ where: { id: fixture.jobA }, include: { tasks: true } }),
    );
    expect(job.tasks.map((t: any) => t.id)).toEqual([fixture.taskA]);
  });

  it('scopes a _count over a relation', async () => {
    const [job] = await as(fixture.claimsA, () =>
      db.job.findMany({
        where: { id: fixture.jobA },
        include: { _count: { select: { tasks: true } } },
      }),
    );
    expect(job._count.tasks).toBe(1);
  });

  it('returns null from findUnique for a row outside the caller scope', async () => {
    const mine = await as(fixture.claimsA, () =>
      db.job.findUnique({ where: { id: fixture.jobA } }),
    );
    const theirs = await as(fixture.claimsA, () =>
      db.job.findUnique({ where: { id: fixture.jobB } }),
    );
    expect(mine.id).toBe(fixture.jobA);
    expect(theirs).toBeNull();
  });

  it('throws from findUniqueOrThrow for a row outside the caller scope', async () => {
    await expect(
      as(fixture.claimsA, () => db.job.findUniqueOrThrow({ where: { id: fixture.jobB } })),
    ).rejects.toThrow();
  });

  it('scopes count', async () => {
    expect(await as(fixture.claimsA, () => db.job.count())).toBe(1);
    expect(await as(fixture.claimsB, () => db.job.count())).toBe(1);
  });

  it('returns omitted columns and does not clamp take, unlike the client profile', async () => {
    const jobs = await as(fixture.claimsA, () => db.job.findMany({ take: 5000 }));
    // `metadata` is omitted by the policy: hidden from browsers, not from the server process.
    expect(jobs[0].metadata).toEqual({ tenant: 'a' });
  });

  it('refuses to read a model with no client-accessible policy', async () => {
    await expect(as(fixture.claimsA, () => db.user.findMany())).rejects.toBeInstanceOf(
      ScopeViolationError,
    );
  });

  it('refuses to read with no request context at all', async () => {
    await expect(db.job.findMany()).rejects.toThrow(/context/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Writes — ported from the removed PgbaseScopedWriteService suite, same intent
// ─────────────────────────────────────────────────────────────────────────────

describe('scoped writes derive authorization from the read policy', () => {
  it('updates a row the caller can see', async () => {
    await as(fixture.claimsA, () =>
      db.job.update({ where: { id: fixture.jobA }, data: { priority: { increment: 1 } } }),
    );
    const row = await prisma.job.findUniqueOrThrow({ where: { id: fixture.jobA } });
    expect(row.priority).toBe(6);
  });

  it("refuses to update another tenant's row, and leaves it untouched", async () => {
    await expect(
      as(fixture.claimsA, () =>
        db.job.update({ where: { id: fixture.jobB }, data: { name: 'HACKED' } }),
      ),
    ).rejects.toBeInstanceOf(ScopedRowNotFoundError);
    const row = await prisma.job.findUniqueOrThrow({ where: { id: fixture.jobB } });
    expect(row.name).toBe('job-b');
  });

  it('rolls back an update that would move the row out of the caller scope', async () => {
    // The post-image check runs after the UPDATE — `{ increment }` and friends make the result
    // unpredictable client-side — so only a real rollback keeps this from committing.
    await expect(
      as(fixture.claimsA, () =>
        db.job.update({ where: { id: fixture.jobA }, data: { orgId: fixture.orgB } }),
      ),
    ).rejects.toBeInstanceOf(ScopeViolationError);
    const row = await prisma.job.findUniqueOrThrow({ where: { id: fixture.jobA } });
    expect(row.orgId).toBe(fixture.orgA);
  });

  it('still checks the post-image when the caller asked for a projection', async () => {
    await expect(
      as(fixture.claimsA, () =>
        db.job.update({
          where: { id: fixture.jobA },
          data: { orgId: fixture.orgB },
          select: { id: true },
        }),
      ),
    ).rejects.toBeInstanceOf(ScopeViolationError);
    const row = await prisma.job.findUniqueOrThrow({ where: { id: fixture.jobA } });
    expect(row.orgId).toBe(fixture.orgA);
  });

  it("refuses to delete another tenant's row", async () => {
    await expect(
      as(fixture.claimsA, () => db.task.delete({ where: { id: fixture.taskB } })),
    ).rejects.toBeInstanceOf(ScopedRowNotFoundError);
    expect(await prisma.task.findUnique({ where: { id: fixture.taskB } })).not.toBeNull();
  });

  it('deletes a row the caller can see', async () => {
    const doomed = await prisma.task.create({
      data: { orgId: fixture.orgA, jobId: fixture.jobA, title: 'doomed' },
    });
    await as(fixture.claimsA, () => db.task.delete({ where: { id: doomed.id } }));
    expect(await prisma.task.findUnique({ where: { id: doomed.id } })).toBeNull();
  });

  it('refuses to create a row outside the caller scope', async () => {
    await expect(
      as(fixture.claimsA, () => db.job.create({ data: { orgId: fixture.orgB, name: 'smuggled' } })),
    ).rejects.toBeInstanceOf(ScopeViolationError);
    expect(await prisma.job.findFirst({ where: { name: 'smuggled' } })).toBeNull();
  });

  it('creates a row inside the caller scope', async () => {
    const created = await as(fixture.claimsA, () =>
      db.job.create({ data: { orgId: fixture.orgA, name: 'legit' } }),
    );
    expect(created.orgId).toBe(fixture.orgA);
    await prisma.job.delete({ where: { id: created.id } });
  });

  it('refuses to write with no request context at all', async () => {
    await expect(
      db.job.update({ where: { id: fixture.jobA }, data: { name: 'X' } }),
    ).rejects.toThrow(/context/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The gaps, held open deliberately
// ─────────────────────────────────────────────────────────────────────────────

describe('operations that cannot be scoped yet fail loudly', () => {
  it('rejects a nested create rather than writing an unchecked row', async () => {
    await expect(
      as(fixture.claimsA, () =>
        db.job.create({
          data: {
            orgId: fixture.orgA,
            name: 'parent',
            tasks: { create: [{ orgId: fixture.orgB, title: 'smuggled' }] },
          },
        }),
      ),
    ).rejects.toBeInstanceOf(ScopeViolationError);
    expect(await prisma.task.findFirst({ where: { title: 'smuggled' } })).toBeNull();
  });

  it('rejects a nested connect on update', async () => {
    await expect(
      as(fixture.claimsA, () =>
        db.job.update({
          where: { id: fixture.jobA },
          data: { tasks: { connect: { id: fixture.taskB } } },
        }),
      ),
    ).rejects.toBeInstanceOf(ScopeViolationError);
  });

  it.each(['upsert', 'updateMany', 'deleteMany', 'createMany'])('rejects %s', async (operation) => {
    await expect(
      as(fixture.claimsA, () => db.job[operation]({ where: {}, data: {}, create: {}, update: {} })),
    ).rejects.toBeInstanceOf(ScopeViolationError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// One client instance, many callers
// ─────────────────────────────────────────────────────────────────────────────

describe('concurrent requests under different claims do not cross', () => {
  it('resolves each caller against its own claims, not whichever ran first', async () => {
    const interleaved = await Promise.all([
      as(fixture.claimsA, async () => {
        const first = await db.job.findMany();
        // Yield mid-request so B is guaranteed to be in flight when A resumes.
        await new Promise((resolve) => setTimeout(resolve, 10));
        const second = await db.job.findMany();
        return [first, second].map((rows) => rows.map((j: any) => j.id));
      }),
      as(fixture.claimsB, async () => {
        const rows = await db.job.findMany();
        return rows.map((j: any) => j.id);
      }),
    ]);

    expect(interleaved[0]).toEqual([[fixture.jobA], [fixture.jobA]]);
    expect(interleaved[1]).toEqual([fixture.jobB]);
  });
});
