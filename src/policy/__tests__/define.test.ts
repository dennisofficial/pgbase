import { describe, expect, it } from 'vitest';
import { definePolicy, type PolicyRegistry } from '../define.js';
import { NO_CLIENT_ACCESS } from '../types.js';

interface Job {
  readonly id: string;
  readonly name: string;
}
interface Claims {
  readonly orgIds: readonly string[];
}

describe('definePolicy', () => {
  it('returns a Policy carrying model/omit/rls through unchanged', () => {
    const rls = (claims: Claims) => ({ orgId: { in: [...claims.orgIds] } });

    const policy = definePolicy<Job, Claims>('Job')({ omit: ['name'], rls });

    expect(policy.model).toBe('Job');
    expect(policy.omit).toEqual(['name']);
    expect(policy.rls).toBe(rls);
  });

  it('omit defaults to empty when not supplied', () => {
    const policy = definePolicy<Job, Claims>('Job')({ rls: () => ({}) });
    expect(policy.omit).toEqual([]);
  });
});

// Simulates `Prisma.ModelName` — pgbase never imports `@prisma/client` itself, so this is exactly
// the shape a consumer supplies.
type ModelName = 'Job' | 'JobSettings' | 'AuditLog';

const jobPolicy = definePolicy<Job, Claims>('Job')({
  omit: ['name'],
  rls: (claims) => ({ orgId: { in: [...claims.orgIds] } }),
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
