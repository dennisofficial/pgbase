import type { Pool } from 'pg';
import { definePolicy } from '../../policy/define.js';
import { NO_CLIENT_ACCESS, type PolicyEntry } from '../../policy/types.js';
import { validatePolicies } from '../../policy/validate.js';
import type { ReadContext } from '../scope.js';
import { DEFAULT_READ_LIMITS, type ReadLimits } from '../types.js';
import { resolveReadFixtureSchema } from './fixtures.js';

export interface Claims {
  readonly orgId: string;
}

export const ORG_1 = '11111111-1111-4111-8111-111111111111';
export const ORG_2 = '22222222-2222-4222-8222-222222222222';

interface OrgRow {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export const orgPolicy = definePolicy<OrgRow, Claims>('Org')({
  omit: ['createdAt', 'updatedAt'],
  rls: (claims) => ({ id: claims.orgId }),
});

interface JobRow {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly status: string;
  readonly priority: number;
  readonly labels: readonly string[];
  readonly metadata: unknown;
  readonly closedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export const jobPolicy = definePolicy<JobRow, Claims>('Job')({
  omit: ['orgId', 'labels', 'metadata', 'closedAt', 'createdAt', 'updatedAt'],
  rls: (claims) => ({ orgId: claims.orgId }),
});

interface TaskRow {
  readonly id: string;
  readonly orgId: string;
  readonly jobId: string;
  readonly title: string;
  readonly done: boolean;
  readonly blockedBy: unknown;
  readonly createdAt: Date;
}

export const taskPolicy = definePolicy<TaskRow, Claims>('Task')({
  omit: ['orgId', 'jobId', 'blockedBy', 'createdAt'],
  rls: (claims) => ({ orgId: claims.orgId }),
});

interface JobSettingsRow {
  readonly jobId: string;
  readonly concurrency: number;
  readonly webhookSecret: string;
}

/** Omits `webhookSecret` — the policy a JobSettings model would actually ship with. */
export const jobSettingsPolicyVisible = definePolicy<JobSettingsRow, Claims>('JobSettings')({
  omit: ['webhookSecret'],
  rls: () => ({}),
});

const BASE_REGISTRY = {
  Org: orgPolicy,
  Job: jobPolicy,
  Task: taskPolicy,
} satisfies Record<string, PolicyEntry<any, any, any>>;

/** JobSettings unreachable: the headline "nested include leaks a hidden model" scenario. */
export const REGISTRY_HIDDEN_SETTINGS = {
  ...BASE_REGISTRY,
  JobSettings: NO_CLIENT_ACCESS,
} satisfies Record<string, PolicyEntry<any, any, any>>;

/** JobSettings reachable, but its policy still withholds `webhookSecret`. */
export const REGISTRY_VISIBLE_SETTINGS = {
  ...BASE_REGISTRY,
  JobSettings: jobSettingsPolicyVisible,
} satisfies Record<string, PolicyEntry<any, any, any>>;

export async function buildContext(
  pool: Pool,
  registry: Record<string, PolicyEntry<any, any, any>>,
  claims: Claims = { orgId: ORG_1 },
  limits: ReadLimits = DEFAULT_READ_LIMITS,
): Promise<ReadContext<Claims>> {
  const schema = await resolveReadFixtureSchema(pool);
  const policies = validatePolicies(schema, registry);
  return { schema, policies, claims, limits };
}
