import type { Pool } from 'pg';
import { definePolicy } from '../../policy/define.js';
import { NO_CLIENT_ACCESS, type PolicyEntry } from '../../policy/types.js';
import { validatePolicies } from '../../policy/validate.js';
import { DEFAULT_READ_LIMITS, type ReadLimits } from '../types.js';
import type { ReadContext } from '../scope.js';
import { resolveReadFixtureSchema } from './fixtures.js';

export interface Claims {
  readonly orgId: string;
}

export const ORG_1 = '11111111-1111-4111-8111-111111111111';
export const ORG_2 = '22222222-2222-4222-8222-222222222222';

export const orgPolicy = definePolicy<{ id: string; name: string; slug: string }, unknown, Claims>(
  'Org',
  {
    transform: (row) => ({ id: row.id, name: row.name, slug: row.slug }),
    rls: (claims) => ({ id: claims.orgId }),
  },
);

export const jobPolicy = definePolicy<
  { id: string; orgId: string; name: string; status: string; priority: number },
  unknown,
  Claims
>('Job', {
  transform: (row) => ({ id: row.id, name: row.name, status: row.status, priority: row.priority }),
  rls: (claims) => ({ orgId: claims.orgId }),
});

export const taskPolicy = definePolicy<
  { id: string; orgId: string; jobId: string; title: string; done: boolean },
  unknown,
  Claims
>('Task', {
  transform: (row) => ({ id: row.id, title: row.title, done: row.done }),
  rls: (claims) => ({ orgId: claims.orgId }),
});

/** Omits `webhookSecret` — the transform a JobSettings policy would actually ship with. */
export const jobSettingsPolicyVisible = definePolicy<
  { jobId: string; concurrency: number; webhookSecret: string },
  unknown,
  Claims
>('JobSettings', {
  transform: (row) => ({ jobId: row.jobId, concurrency: row.concurrency }),
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

/** JobSettings reachable, but its transform still withholds `webhookSecret`. */
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
