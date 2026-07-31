import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import generatedSchema from '../../../examples/api/src/generated/pgbase/index.js';
import { PrismaClient } from '../../../examples/api/src/generated/prisma/client.js';
import {
  NO_CLIENT_ACCESS,
  definePolicy,
  validatePolicies,
  type PolicyEntry,
} from '../../policy/index.js';
import { PgCatalogSchemaProvider, type StaticSchema } from '../../schema/index.js';
import { TEST_DATABASE_URL } from '../../schema/test-support.js';
import type { Resolved } from '../tokens.js';

export interface TestClaims {
  readonly userId: string;
  readonly orgIds: readonly string[];
}

interface OrgRow {
  id: string;
}
interface JobRow {
  id: string;
  orgId: string;
  metadata: unknown;
}
interface TaskRow {
  id: string;
  orgId: string;
  jobId: string;
}

const orgPolicy = definePolicy<OrgRow, TestClaims>('Org')({
  rls: (claims) => ({ id: { in: claims.orgIds } }),
});

/** `metadata` is omitted so the client profile has something to strip that the server keeps. */
const jobPolicy = definePolicy<JobRow, TestClaims>('Job')({
  omit: ['metadata'],
  rls: (claims) => ({ orgId: { in: claims.orgIds } }),
});

const taskPolicy = definePolicy<TaskRow, TestClaims>('Task')({
  rls: (claims) => ({ orgId: { in: claims.orgIds } }),
});

const openPolicy = (model: string) =>
  definePolicy<{ id: unknown }, TestClaims>(model)({ rls: () => ({}) });

export const testPolicies: Record<string, PolicyEntry<any, any, any>> = {
  AuditLog: NO_CLIENT_ACCESS,
  Invoice: NO_CLIENT_ACCESS,
  Job: jobPolicy,
  JobSettings: NO_CLIENT_ACCESS,
  JobWatcher: NO_CLIENT_ACCESS,
  Membership: NO_CLIENT_ACCESS,
  Org: orgPolicy,
  Tag: openPolicy('Tag'),
  Task: taskPolicy,
  Thread: NO_CLIENT_ACCESS,
  User: NO_CLIENT_ACCESS,
};

export function createTestPrisma(): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL }) });
}

export async function resolveTestRuntime(pool: Pool): Promise<Resolved> {
  const schema = await new PgCatalogSchemaProvider(
    generatedSchema as unknown as StaticSchema,
    pool,
  ).resolve();
  return { schema, policies: validatePolicies(schema, testPolicies) };
}

export interface Fixture {
  readonly orgA: string;
  readonly orgB: string;
  readonly jobA: string;
  readonly jobB: string;
  readonly taskA: string;
  readonly taskB: string;
  /** Belongs to org B but hangs off org A's job — reachable through `include` if Task's RLS is skipped. */
  readonly crossTask: string;
  readonly claimsA: TestClaims;
  readonly claimsB: TestClaims;
}

/** Two tenants with identically shaped rows — every scoping assertion is "did B's row leak into A". */
export async function seedFixture(prisma: PrismaClient): Promise<Fixture> {
  const mk = async (label: string) => {
    const org = await prisma.org.create({
      data: { name: `scoped-${label}`, slug: `scoped-${label}-${randomUUID()}` },
    });
    const job = await prisma.job.create({
      data: { orgId: org.id, name: `job-${label}`, metadata: { tenant: label } },
    });
    const task = await prisma.task.create({
      data: { orgId: org.id, jobId: job.id, title: `task-${label}` },
    });
    return { org: org.id, job: job.id, task: task.id };
  };

  const a = await mk('a');
  const b = await mk('b');

  // Written with the raw client on purpose: this is the row a nested write would have created, and
  // it is what proves `include` scopes by the relation target's own policy rather than the parent's.
  const cross = await prisma.task.create({
    data: { orgId: b.org, jobId: a.job, title: 'cross-tenant' },
  });

  return {
    orgA: a.org,
    orgB: b.org,
    jobA: a.job,
    jobB: b.job,
    taskA: a.task,
    taskB: b.task,
    crossTask: cross.id,
    claimsA: { userId: randomUUID(), orgIds: [a.org] },
    claimsB: { userId: randomUUID(), orgIds: [b.org] },
  };
}

export async function dropFixture(prisma: PrismaClient, fixture: Fixture): Promise<void> {
  await prisma.org.deleteMany({ where: { id: { in: [fixture.orgA, fixture.orgB] } } });
}

export function createTestPool(): Pool {
  return new Pool({ connectionString: TEST_DATABASE_URL });
}
