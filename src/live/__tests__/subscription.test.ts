import { describe, expect, it } from 'vitest';
import type { Policy } from '../../policy/types.js';
import { createSubscription } from '../subscription.js';
import { WIDGET_MODEL } from './support.js';

/**
 * A policy that omits the very column it scopes on. This is an ordinary shape — a column whose
 * value is always the caller carries no information worth shipping per row — and it has to stay
 * subscribable, because one-shot reads of the same model already work.
 */
const omitsItsOwnRlsColumn: Policy<any, any, any> = {
  model: 'Widget',
  omit: ['secret'],
  rls: (claims: { secret: string }) => ({ secret: { equals: claims.secret } }),
};

describe('createSubscription', () => {
  it('lets the policy predicate reference a column the policy omits', () => {
    const subscription = createSubscription({
      id: 'sub-1',
      model: WIDGET_MODEL,
      policy: omitsItsOwnRlsColumn,
      claims: { secret: 'shh' },
    });

    expect([...subscription.rlsColumns]).toEqual(['secret']);
    expect([...subscription.predicateColumns]).toEqual(['secret']);
  });

  it('still strips that column from what a subscriber receives', () => {
    const subscription = createSubscription({
      id: 'sub-2',
      model: WIDGET_MODEL,
      policy: omitsItsOwnRlsColumn,
      claims: { secret: 'shh' },
    });

    expect(subscription.project({ id: 1, tenant: 't1', score: 5, secret: 'shh' })).toEqual({
      id: 1,
      tenant: 't1',
      score: 5,
    });
  });

  it('still refuses a CLIENT filter on an omitted column', () => {
    expect(() =>
      createSubscription({
        id: 'sub-3',
        model: WIDGET_MODEL,
        policy: omitsItsOwnRlsColumn,
        claims: { secret: 'shh' },
        where: { secret: { startsWith: 'a' } },
      }),
    ).toThrow(/secret/);
  });
});
