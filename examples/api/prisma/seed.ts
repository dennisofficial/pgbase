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

export const USER_ALICE = '00000000-0000-4000-8000-0000000000a1'; // org A
export const USER_BOB = '00000000-0000-4000-8000-0000000000a2'; // org A
export const USER_CAROL = '00000000-0000-4000-8000-0000000000b1'; // org B

export const JOB_A1 = '00000000-0000-4000-8000-0000000a0001';
export const JOB_A2 = '00000000-0000-4000-8000-0000000a0002';
export const JOB_B1 = '00000000-0000-4000-8000-0000000b0001';

async function main(): Promise<void> {
  await prisma.org.upsert({
    where: { id: ORG_A },
    create: { id: ORG_A, name: 'Org A', slug: 'org-a' },
    update: {},
  });
  await prisma.org.upsert({
    where: { id: ORG_B },
    create: { id: ORG_B, name: 'Org B', slug: 'org-b' },
    update: {},
  });

  await prisma.user.upsert({
    where: { id: USER_ALICE },
    create: { id: USER_ALICE, email: 'alice@org-a.example', name: 'Alice' },
    update: {},
  });
  await prisma.user.upsert({
    where: { id: USER_BOB },
    create: { id: USER_BOB, email: 'bob@org-a.example', name: 'Bob' },
    update: {},
  });
  await prisma.user.upsert({
    where: { id: USER_CAROL },
    create: { id: USER_CAROL, email: 'carol@org-b.example', name: 'Carol' },
    update: {},
  });

  await prisma.membership.upsert({
    where: { orgId_userId: { orgId: ORG_A, userId: USER_ALICE } },
    create: { orgId: ORG_A, userId: USER_ALICE, role: 'OWNER' },
    update: {},
  });
  await prisma.membership.upsert({
    where: { orgId_userId: { orgId: ORG_A, userId: USER_BOB } },
    create: { orgId: ORG_A, userId: USER_BOB, role: 'MEMBER' },
    update: {},
  });
  await prisma.membership.upsert({
    where: { orgId_userId: { orgId: ORG_B, userId: USER_CAROL } },
    create: { orgId: ORG_B, userId: USER_CAROL, role: 'OWNER' },
    update: {},
  });

  await prisma.job.upsert({
    where: { id: JOB_A1 },
    create: {
      id: JOB_A1,
      orgId: ORG_A,
      name: 'org-a deploy',
      status: JobStatus.RUNNING,
      priority: 5,
      labels: ['deploy', 'p0'],
    },
    update: {},
  });
  await prisma.job.upsert({
    where: { id: JOB_A2 },
    create: { id: JOB_A2, orgId: ORG_A, name: 'org-a backup', status: JobStatus.QUEUED },
    update: {},
  });
  await prisma.job.upsert({
    where: { id: JOB_B1 },
    create: { id: JOB_B1, orgId: ORG_B, name: 'org-b deploy', status: JobStatus.RUNNING },
    update: {},
  });

  await prisma.jobSettings.upsert({
    where: { jobId: JOB_A1 },
    create: { jobId: JOB_A1, concurrency: 3, webhookSecret: 'whsec_org_a_do_not_leak' },
    update: {},
  });
  await prisma.jobSettings.upsert({
    where: { jobId: JOB_B1 },
    create: { jobId: JOB_B1, concurrency: 1, webhookSecret: 'whsec_org_b_do_not_leak' },
    update: {},
  });

  await prisma.task.deleteMany({ where: { jobId: { in: [JOB_A1, JOB_A2, JOB_B1] } } });
  await prisma.task.createMany({
    data: [
      { orgId: ORG_A, jobId: JOB_A1, title: 'provision', done: true },
      { orgId: ORG_A, jobId: JOB_A1, title: 'migrate', done: false },
      { orgId: ORG_A, jobId: JOB_A2, title: 'snapshot', done: false },
      { orgId: ORG_B, jobId: JOB_B1, title: 'provision', done: true },
    ],
  });

  console.log('Seeded:');
  console.log(`  Org A ${ORG_A} — users alice=${USER_ALICE} bob=${USER_BOB}`);
  console.log(`  Org B ${ORG_B} — user carol=${USER_CAROL}`);
  console.log(`  Jobs: A1=${JOB_A1} A2=${JOB_A2} (org A), B1=${JOB_B1} (org B)`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
