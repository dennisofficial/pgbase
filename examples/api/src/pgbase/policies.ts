import { NO_CLIENT_ACCESS, definePolicy, type PolicyRegistry } from '@workspace/pgbase/policy';
import type { Prisma } from '../generated/prisma/client.js';
import type {
  AuditLogModel,
  InvoiceModel,
  JobModel,
  JobWatcherModel,
  MembershipModel,
  OrgModel,
  TagModel,
  TaskModel,
  ThreadModel,
  UserModel,
} from '../generated/prisma/models.js';
import type { Claims } from './claims.js';

const jobPolicy = definePolicy<JobModel, Claims>('Job')({
  rls: (claims) => ({ orgId: { in: claims.orgIds } }),
});

const taskPolicy = definePolicy<TaskModel, Claims>('Task')({
  rls: (claims) => ({ orgId: { in: claims.orgIds } }),
});

const orgPolicy = definePolicy<OrgModel, Claims>('Org')({
  rls: (claims) => ({ id: { in: claims.orgIds } }),
});

const userPolicy = definePolicy<UserModel, Claims>('User')({
  // A static predicate over User's own columns can't express "shares an org with the caller" —
  // the claims builder precomputes that set (§5.1's ortho pattern) so RLS stays a plain `in`.
  rls: (claims) => ({ id: { in: claims.visibleUserIds } }),
});

const membershipPolicy = definePolicy<MembershipModel, Claims>('Membership')({
  rls: (claims) => ({ orgId: { in: claims.orgIds } }),
});

const threadPolicy = definePolicy<ThreadModel, Claims>('Thread')({
  rls: (claims) => ({ orgId: { in: claims.orgIds } }),
});

const invoicePolicy = definePolicy<InvoiceModel, Claims>('Invoice')({
  rls: (claims) => ({ orgId: { in: claims.orgIds } }),
});

const jobWatcherPolicy = definePolicy<JobWatcherModel, Claims>('JobWatcher')({
  // No orgId on this table — join_watchers is scoped to what the caller subscribed themselves to.
  rls: (claims) => ({ userId: { equals: claims.userId } }),
});

const tagPolicy = definePolicy<TagModel, Claims>('Tag')({
  // Tags are a shared, org-agnostic vocabulary — nothing here is per-tenant confidential.
  rls: () => ({}),
});

const auditLogPolicy = definePolicy<AuditLogModel, Claims>('AuditLog')({
  omit: ['action', 'actorId', 'at'],
  rls: (claims) => ({ actorId: { equals: claims.userId } }),
});

/** Exhaustive: a model missing from this object is a tsc error, not a boot-time surprise. */
export const pgbasePolicies = {
  AuditLog: auditLogPolicy,
  Invoice: invoicePolicy,
  Job: jobPolicy,
  // Holds `webhookSecret` — never reachable from the client, not even nested under `include`.
  JobSettings: NO_CLIENT_ACCESS,
  JobWatcher: jobWatcherPolicy,
  Membership: membershipPolicy,
  Org: orgPolicy,
  Tag: tagPolicy,
  Task: taskPolicy,
  Thread: threadPolicy,
  User: userPolicy,
} satisfies PolicyRegistry<Prisma.ModelName>;
