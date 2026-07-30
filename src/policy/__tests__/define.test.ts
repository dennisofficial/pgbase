import { describe, expect, it } from 'vitest';
import { definePolicy, type PolicyRegistry } from '../define.js';
import { NO_CLIENT_ACCESS } from '../types.js';

interface Job {
  readonly id: string;
  readonly name: string;
}
interface JobView {
  readonly id: string;
}
interface Claims {
  readonly orgIds: readonly string[];
}

describe('definePolicy', () => {
  it('returns a Policy carrying model/transform/rls through unchanged', () => {
    const transform = (row: Job): JobView => ({ id: row.id });
    const rls = (claims: Claims) => ({ orgId: { in: [...claims.orgIds] } });

    const policy = definePolicy('Job', { transform, rls });

    expect(policy.model).toBe('Job');
    expect(policy.transform).toBe(transform);
    expect(policy.rls).toBe(rls);
  });
});

// Simulates `Prisma.ModelName` — pgbase never imports `@prisma/client` itself, so this is exactly
// the shape a consumer supplies.
type ModelName = 'Job' | 'JobSettings' | 'AuditLog';

const jobPolicy = definePolicy('Job', {
  transform: (row: Job): JobView => ({ id: row.id }),
  rls: (claims: Claims) => ({ orgId: { in: [...claims.orgIds] } }),
});

describe('PolicyRegistry — exhaustiveness is a compile-time property', () => {
  it('an exhaustive registry, mixing typed policies and NO_CLIENT_ACCESS, satisfies the type', () => {
    const registry = {
      Job: jobPolicy,
      JobSettings: NO_CLIENT_ACCESS,
      AuditLog: NO_CLIENT_ACCESS,
    } satisfies PolicyRegistry<ModelName>;

    expect(registry.Job.model).toBe('Job');
    expect(registry.JobSettings).toBe(NO_CLIENT_ACCESS);
  });

  it('a registry missing a model is a tsc error, not a runtime one', () => {
    const registry = {
      Job: jobPolicy,
      JobSettings: NO_CLIENT_ACCESS,
      // @ts-expect-error — "AuditLog" is missing.
    } satisfies PolicyRegistry<ModelName>;
    expect(registry).toBeTruthy();
  });

  it('a registry naming an unknown model is a tsc error, not a runtime one', () => {
    const registry = {
      Job: jobPolicy,
      JobSettings: NO_CLIENT_ACCESS,
      AuditLog: NO_CLIENT_ACCESS,
      // @ts-expect-error — "Bogus" is not a model in `ModelName`.
      Bogus: NO_CLIENT_ACCESS,
    } satisfies PolicyRegistry<ModelName>;
    expect(registry).toBeTruthy();
  });
});
