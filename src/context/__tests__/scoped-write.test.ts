import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveFixtureSchema } from '../../policy/__tests__/fixtures.js';
import { definePolicy } from '../../policy/define.js';
import { evaluate } from '../../query/evaluate.js';
import { normalize } from '../../query/normalize.js';
import { createTestPool } from '../../schema/test-support.js';
import type { ResolvedModel } from '../../schema/types.js';
import { assertCreateInScope, assertUpdateStaysInScope, scopedWhere } from '../scoped-write.js';
import { ScopeViolationError } from '../types.js';

interface Claims {
  readonly orgId: string;
}

const ORG_1 = '11111111-1111-4111-8111-111111111111';
const ORG_2 = '22222222-2222-4222-8222-222222222222';

const jobPolicy = definePolicy<Record<string, unknown>, Claims>('Job')({
  rls: (claims) => ({ orgId: claims.orgId }),
});

let pool: Pool;
let job: ResolvedModel;

beforeAll(async () => {
  pool = createTestPool();
  const schema = await resolveFixtureSchema(pool);
  job = schema.byModel.get('Job')!;
});

afterAll(async () => {
  await pool.end();
});

const claims: Claims = { orgId: ORG_1 };

describe('assertCreateInScope — FIELD-keyed row', () => {
  it('passes when the row satisfies RLS', () => {
    expect(() => assertCreateInScope(jobPolicy, claims, job, { orgId: ORG_1 })).not.toThrow();
  });

  it('throws ScopeViolationError when the row is out of scope', () => {
    expect(() => assertCreateInScope(jobPolicy, claims, job, { orgId: ORG_2 })).toThrow(
      ScopeViolationError,
    );
  });

  it('throws when a column the RLS predicate references is NULL (predicate is UNKNOWN, not false)', () => {
    expect(() => assertCreateInScope(jobPolicy, claims, job, { orgId: null })).toThrow(
      ScopeViolationError,
    );
  });

  it('names the model and write kind on the thrown error', () => {
    expect.assertions(2);
    try {
      assertCreateInScope(jobPolicy, claims, job, { orgId: ORG_2 });
    } catch (err) {
      expect(err).toBeInstanceOf(ScopeViolationError);
      const violation = err as ScopeViolationError;
      expect(violation.model === 'Job' && violation.kind === 'create').toBe(true);
    }
  });

  it('RLS may reference a column even if it is not in ProbeResult.filterable — it is server-authored', () => {
    // orgId is not passed through any allowlist here at all; assertCreateInScope must still see it.
    expect(() => assertCreateInScope(jobPolicy, claims, job, { orgId: ORG_2 })).toThrow(/RLS/);
  });
});

describe('assertUpdateStaysInScope — post-image check', () => {
  it('passes when the post-image is still in scope', () => {
    expect(() => assertUpdateStaysInScope(jobPolicy, claims, job, { orgId: ORG_1 })).not.toThrow();
  });

  it('throws when the post-image moves the row to another org — an unauthorized delete-by-reassignment', () => {
    expect(() => assertUpdateStaysInScope(jobPolicy, claims, job, { orgId: ORG_2 })).toThrow(
      ScopeViolationError,
    );
  });

  it('the thrown error carries kind "update", distinct from "create"', () => {
    expect.assertions(1);
    try {
      assertUpdateStaysInScope(jobPolicy, claims, job, { orgId: ORG_2 });
    } catch (err) {
      expect((err as ScopeViolationError).kind).toBe('update');
    }
  });
});

describe('scopedWhere — RLS outermost', () => {
  it('wraps the client where in { AND: [rls, userWhere] }', () => {
    const userWhere = { priority: { gte: 0 } };
    expect(scopedWhere(jobPolicy, claims, userWhere)).toEqual({
      AND: [{ orgId: ORG_1 }, userWhere],
    });
  });

  it('a client-supplied OR cannot escape scope: the combined predicate still requires RLS', () => {
    const attackerWhere = { OR: [{ orgId: ORG_2 }, { priority: { gte: 0 } }] };
    const combined = scopedWhere(jobPolicy, claims, attackerWhere);

    const allowedFields = new Set(job.fields.map((f) => f.name));
    const predicate = normalize(combined, job, allowedFields);

    const outOfScopeRow = { org_id: ORG_2, priority: 5 };
    expect(evaluate(predicate, outOfScopeRow)).toBe(false);

    const inScopeRow = { org_id: ORG_1, priority: 5 };
    expect(evaluate(predicate, inScopeRow)).toBe(true);
  });
});

describe('assertCreateInScope — undecidable vs out-of-scope', () => {
  it('names the missing field instead of reporting a scope violation', () => {
    // A create payload legitimately omits columns with DB defaults. If RLS references one, the
    // failure is "cannot decide", not "you tried to escape scope" — and the message must say so
    // or the developer goes hunting for a security bug that isn't there.
    expect(() => assertCreateInScope(jobPolicy, claims, job, { name: 'x' })).toThrow(
      /RLS references "orgId".*payload does not set/s,
    );
  });

  it('still reports a genuine out-of-scope row as a scope violation', () => {
    expect(() => assertCreateInScope(jobPolicy, claims, job, { orgId: ORG_2 })).toThrow(
      /does not satisfy RLS/,
    );
  });
});
