import { describe, expect, it } from 'vitest';
import type { ChangeEvent } from '../../wal/types.js';
import { InMemorySubscriptionRegistry } from '../registry.js';
import { DefaultChangeRouter } from '../router.js';
import { widgetSubscription } from './support.js';

function change(overrides: Partial<ChangeEvent> = {}): ChangeEvent {
  return {
    kind: 'insert',
    model: 'Widget',
    table: 'widgets',
    schema: 'public',
    lsn: '0/1',
    commitLsn: '0/1',
    commitTime: 0n,
    newRow: null,
    oldRow: null,
    unknownColumns: new Set(),
    ...overrides,
  };
}

function setup() {
  const registry = new InMemorySubscriptionRegistry();
  const router = new DefaultChangeRouter(registry);
  return { registry, router };
}

describe('insert', () => {
  it('matching row emits upsert', () => {
    const { registry, router } = setup();
    registry.add(widgetSubscription('s1', { tenant: 'A' }));
    const result = router.route(
      change({ kind: 'insert', newRow: { id: 1, tenant: 'A', score: 5, secret: 'shh' } }),
    );
    expect(result.deltas).toEqual([
      { kind: 'upsert', subscriptionId: 's1', row: expect.anything() },
    ]);
    expect(result.undecidable).toEqual([]);
  });

  it('non-matching row emits nothing', () => {
    const { registry, router } = setup();
    registry.add(widgetSubscription('s1', { tenant: 'A' }));
    const result = router.route(
      change({ kind: 'insert', newRow: { id: 1, tenant: 'B', score: 5, secret: 'shh' } }),
    );
    expect(result.deltas).toEqual([]);
    expect(result.undecidable).toEqual([]);
  });
});

describe('update — decided purely from the post-image', () => {
  it('in scope -> in scope: upsert', () => {
    const { registry, router } = setup();
    registry.add(widgetSubscription('s1', { tenant: 'A' }));
    const result = router.route(
      change({ kind: 'update', newRow: { id: 1, tenant: 'A', score: 9, secret: 'x' } }),
    );
    expect(result.deltas).toEqual([
      { kind: 'upsert', subscriptionId: 's1', row: expect.anything() },
    ]);
  });

  it('in scope -> out of scope: remove keyed off the post-image', () => {
    const { registry, router } = setup();
    registry.add(widgetSubscription('s1', { tenant: 'A' }));
    const result = router.route(
      change({ kind: 'update', newRow: { id: 1, tenant: 'B', score: 9, secret: 'x' } }),
    );
    expect(result.deltas).toEqual([{ kind: 'remove', subscriptionId: 's1', key: { id: 1 } }]);
  });

  it('out of scope -> in scope: upsert', () => {
    const { registry, router } = setup();
    registry.add(widgetSubscription('s1', { tenant: 'A' }));
    const result = router.route(
      change({ kind: 'update', newRow: { id: 1, tenant: 'A', score: 9, secret: 'x' } }),
    );
    expect(result.deltas[0]).toMatchObject({ kind: 'upsert', subscriptionId: 's1' });
  });

  it('out of scope -> out of scope: remove, harmless because it is idempotent', () => {
    const { registry, router } = setup();
    registry.add(widgetSubscription('s1', { tenant: 'A' }));
    const result = router.route(
      change({ kind: 'update', newRow: { id: 1, tenant: 'C', score: 9, secret: 'x' } }),
    );
    expect(result.deltas).toEqual([{ kind: 'remove', subscriptionId: 's1', key: { id: 1 } }]);
  });
});

describe('delete', () => {
  it('emits remove keyed off the pre-image without evaluating the predicate', () => {
    const { registry, router } = setup();
    // Predicate reads "tenant", which a key-only pre-image (REPLICA IDENTITY DEFAULT) never has.
    // If the router tried to evaluate it, this would throw or need a resync — it must do neither.
    registry.add(widgetSubscription('s1', { tenant: 'A' }));
    const result = router.route(change({ kind: 'delete', oldRow: { id: 42 } }));
    expect(result.deltas).toEqual([{ kind: 'remove', subscriptionId: 's1', key: { id: 42 } }]);
    expect(result.undecidable).toEqual([]);
  });
});

describe('unknownColumns vs predicateColumns', () => {
  it('an unknown column the predicate reads forces a resync, not a guess', () => {
    const { registry, router } = setup();
    registry.add(widgetSubscription('s1', { tenant: 'A' }));
    const result = router.route(
      change({
        kind: 'update',
        newRow: { id: 1, score: 9, secret: 'x' }, // tenant missing
        unknownColumns: new Set(['tenant']),
      }),
    );
    expect(result.deltas).toEqual([
      { kind: 'resync', subscriptionId: 's1', reason: expect.stringContaining('tenant') },
    ]);
    expect(result.undecidable).toEqual(['s1']);
  });

  it('an unknown column the predicate does not read is routed normally', () => {
    const { registry, router } = setup();
    registry.add(widgetSubscription('s1', { tenant: 'A' }));
    const result = router.route(
      change({
        kind: 'insert',
        newRow: { id: 1, tenant: 'A', secret: 'x' }, // score missing
        unknownColumns: new Set(['score']),
      }),
    );
    expect(result.deltas).toEqual([
      { kind: 'upsert', subscriptionId: 's1', row: expect.anything() },
    ]);
    expect(result.undecidable).toEqual([]);
  });
});

describe('projection', () => {
  it('an omitted column never reaches a subscriber, on insert or update', () => {
    const { registry, router } = setup();
    registry.add(widgetSubscription('s1', {}));
    const inserted = router.route(
      change({ kind: 'insert', newRow: { id: 1, tenant: 'A', score: 1, secret: 'nope' } }),
    );
    const updated = router.route(
      change({ kind: 'update', newRow: { id: 1, tenant: 'A', score: 2, secret: 'nope' } }),
    );
    for (const result of [inserted, updated]) {
      const upsert = result.deltas[0] as { row: Record<string, unknown> };
      expect(upsert.row).toEqual({ id: 1, tenant: 'A', score: expect.any(Number) });
      expect('secret' in upsert.row).toBe(false);
    }
  });
});

describe('unsubscribe during routing', () => {
  it('does not corrupt the walk or throw', () => {
    const { registry, router } = setup();
    let unsubS2: (() => void) | null = null;
    // s1's projector has the side effect of unsubscribing s2 mid-route, simulating a subscriber
    // that drops off (e.g. socket closes) while this exact change is being routed.
    registry.add(
      widgetSubscription('s1', {}, (row) => {
        unsubS2?.();
        return row;
      }),
    );
    unsubS2 = registry.add(widgetSubscription('s2', {}));
    registry.add(widgetSubscription('s3', {}));

    expect(() =>
      router.route(
        change({ kind: 'insert', newRow: { id: 1, tenant: 'A', score: 1, secret: 'x' } }),
      ),
    ).not.toThrow();

    const result = router.route(
      change({ kind: 'insert', newRow: { id: 2, tenant: 'A', score: 1, secret: 'x' } }),
    );
    // s2 is genuinely gone for the *next* change; s1 and s3 remain.
    expect(result.deltas.map((d) => d.subscriptionId).sort()).toEqual(['s1', 's3']);
    expect(registry.size).toBe(2);
  });
});

describe('routeResync', () => {
  it('fans out to every subscription named in tables', () => {
    const { registry, router } = setup();
    registry.add(widgetSubscription('s1', {}));
    const result = router.routeResync({
      reason: 'truncate',
      detail: 'TRUNCATE affecting Widget.',
      tables: ['Widget'],
      lsn: null,
    });
    expect(result.deltas).toEqual([
      { kind: 'resync', subscriptionId: 's1', reason: expect.any(String) },
    ]);
    expect(result.undecidable).toEqual(['s1']);
  });

  it("tables: 'all' reaches every model, not just ones already routed to", () => {
    const { registry, router } = setup();
    registry.add(widgetSubscription('s1', {}));
    const result = router.routeResync({
      reason: 'slot-recreated',
      detail: 'slot recreated',
      tables: 'all',
      lsn: null,
    });
    expect(result.undecidable).toEqual(['s1']);
  });
});
