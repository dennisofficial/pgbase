import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { JobStatus } from '../src/generated/prisma/enums.js';

try {
  process.loadEnvFile();
} catch {}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is not set.');

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

export const ORG_A = '00000000-0000-4000-8000-00000000000a';
export const ORG_B = '00000000-0000-4000-8000-00000000000b';

export const USER_ALICE = '00000000-0000-4000-8000-0000000000a1'; // Northwind Robotics
export const USER_BOB = '00000000-0000-4000-8000-0000000000a2'; // Northwind Robotics
export const USER_CAROL = '00000000-0000-4000-8000-0000000000b1'; // Acme Freight

export const JOB_A1 = '00000000-0000-4000-8000-0000000a0001';
export const JOB_A2 = '00000000-0000-4000-8000-0000000a0002';
export const JOB_A3 = '00000000-0000-4000-8000-0000000a0003';
export const JOB_A4 = '00000000-0000-4000-8000-0000000a0004';
export const JOB_B1 = '00000000-0000-4000-8000-0000000b0001';
export const JOB_B2 = '00000000-0000-4000-8000-0000000b0002';

/**
 * At most one RUNNING job per org: `jobs_one_running_per_org` is a partial unique index added by
 * hand in the initial migration, and the app surfaces the conflict rather than hiding it.
 */
const JOBS = [
  {
    id: JOB_A1,
    orgId: ORG_A,
    name: 'Deploy api v2.14.0',
    status: JobStatus.RUNNING,
    priority: 5,
    labels: ['deploy', 'urgent'],
  },
  {
    id: JOB_A2,
    orgId: ORG_A,
    name: 'Nightly database backup',
    status: JobStatus.QUEUED,
    priority: 1,
    labels: ['backup'],
  },
  {
    id: JOB_A3,
    orgId: ORG_A,
    name: 'Rotate warehouse credentials',
    status: JobStatus.QUEUED,
    priority: 3,
    labels: ['security', 'urgent'],
  },
  {
    id: JOB_A4,
    orgId: ORG_A,
    name: 'Reindex search cluster',
    status: JobStatus.DONE,
    priority: 0,
    labels: ['maintenance'],
  },
  {
    id: JOB_B1,
    orgId: ORG_B,
    name: 'Import carrier rate cards',
    status: JobStatus.RUNNING,
    priority: 2,
    labels: ['import'],
  },
  {
    id: JOB_B2,
    orgId: ORG_B,
    name: 'Recompute delivery ETAs',
    status: JobStatus.FAILED,
    priority: 4,
    labels: ['urgent'],
  },
] as const;

const TASKS = [
  { jobId: JOB_A1, title: 'Build image', done: true },
  { jobId: JOB_A1, title: 'Run migrations', done: true },
  { jobId: JOB_A1, title: 'Shift traffic to canary', done: false },
  { jobId: JOB_A1, title: 'Promote to 100%', done: false },
  { jobId: JOB_A2, title: 'Snapshot primary', done: false },
  { jobId: JOB_A2, title: 'Verify restore', done: false },
  { jobId: JOB_A3, title: 'Issue new credentials', done: false },
  { jobId: JOB_A4, title: 'Rebuild index', done: true },
  { jobId: JOB_B1, title: 'Fetch rate cards', done: true },
  { jobId: JOB_B1, title: 'Validate zone coverage', done: false },
  { jobId: JOB_B2, title: 'Reprocess failed batch', done: false },
] as const;

const TAGS = ['deploy', 'backup', 'security', 'maintenance', 'import', 'urgent'];

/** Decimal(18,4) and int8, both past what a JS number holds exactly — see models/billing.prisma. */
const INVOICES = [
  {
    id: '00000000-0000-4000-8000-00000000fa01',
    orgId: ORG_A,
    amount: '18450.5000',
    externalRef: 9007199254740993n,
  },
  {
    id: '00000000-0000-4000-8000-00000000fa02',
    orgId: ORG_A,
    amount: '2199.9900',
    externalRef: 9007199254740994n,
  },
  {
    id: '00000000-0000-4000-8000-00000000fb01',
    orgId: ORG_B,
    amount: '76310.2500',
    externalRef: 9007199254740995n,
  },
] as const;

const USERS = [
  {
    id: USER_ALICE,
    email: 'alice@northwind.example',
    name: 'Alice Chen',
    orgId: ORG_A,
    role: 'OWNER',
  },
  { id: USER_BOB, email: 'bob@northwind.example', name: 'Bob Osei', orgId: ORG_A, role: 'MEMBER' },
  {
    id: USER_CAROL,
    email: 'carol@acme-freight.example',
    name: 'Carol Vega',
    orgId: ORG_B,
    role: 'OWNER',
  },
] as const;

async function main(): Promise<void> {
  await prisma.org.upsert({
    where: { id: ORG_A },
    create: { id: ORG_A, name: 'Northwind Robotics', slug: 'northwind' },
    update: { name: 'Northwind Robotics', slug: 'northwind' },
  });
  await prisma.org.upsert({
    where: { id: ORG_B },
    create: { id: ORG_B, name: 'Acme Freight', slug: 'acme-freight' },
    update: { name: 'Acme Freight', slug: 'acme-freight' },
  });

  for (const { id, email, name, orgId, role } of USERS) {
    await prisma.user.upsert({
      where: { id },
      create: { id, email, name },
      update: { email, name },
    });
    await prisma.membership.upsert({
      where: { orgId_userId: { orgId, userId: id } },
      create: { orgId, userId: id, role },
      update: { role },
    });
  }

  for (const name of TAGS) {
    await prisma.tag.upsert({ where: { name }, create: { name }, update: {} });
  }

  // Jobs are replaced rather than upserted: a demo that has been clicked through should come back
  // to a known board, not to whatever state the last session left behind.
  await prisma.job.deleteMany({ where: { id: { in: JOBS.map((j) => j.id) } } });

  for (const job of JOBS) {
    await prisma.job.create({
      data: {
        ...job,
        labels: [...job.labels],
        closedAt:
          job.status === JobStatus.DONE || job.status === JobStatus.FAILED ? new Date() : null,
        tags: { connect: job.labels.map((name) => ({ name })) },
      },
    });
  }

  await prisma.task.createMany({
    data: TASKS.map((task) => ({ ...task, orgId: JOBS.find((j) => j.id === task.jobId)!.orgId })),
  });

  await prisma.jobSettings.upsert({
    where: { jobId: JOB_A1 },
    create: { jobId: JOB_A1, concurrency: 3, webhookSecret: 'whsec_northwind_do_not_leak' },
    update: {},
  });
  await prisma.jobSettings.upsert({
    where: { jobId: JOB_B1 },
    create: { jobId: JOB_B1, concurrency: 1, webhookSecret: 'whsec_acme_do_not_leak' },
    update: {},
  });

  for (const invoice of INVOICES) {
    await prisma.invoice.upsert({
      where: { id: invoice.id },
      create: { ...invoice },
      update: { amount: invoice.amount },
    });
  }

  console.log('Seeded:');
  console.log(`  Northwind Robotics — alice=${USER_ALICE} bob=${USER_BOB}`);
  console.log(`  Acme Freight       — carol=${USER_CAROL}`);
  console.log(
    `  ${JOBS.length} jobs, ${TASKS.length} checklist items, ${INVOICES.length} invoices`,
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
