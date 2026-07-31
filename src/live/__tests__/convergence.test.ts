import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scopedWhere } from '../../context/scoped-write.js';
import { definePolicy } from '../../policy/define.js';
import { computeFilterable } from '../../policy/filterable.js';
import type { Policy } from '../../policy/types.js';
import { compileSql } from '../../query/compile-sql.js';
import { normalize } from '../../query/normalize.js';
import { createTestPool } from '../../schema/test-support.js';
import type { ResolvedModel } from '../../schema/types.js';
import { resolveSimpleModel, schemaOf } from '../../wal/__tests__/simple-model.js';
import {
  WAL_REPLICATION_CONFIG,
  createPublication,
  dropPublication,
  dropSlotIfExists,
  waitFor,
} from '../../wal/__tests__/support.js';
import { createWalLeader } from '../../wal/leader.js';
import type { WalLeader } from '../../wal/types.js';
import { InMemorySubscriptionRegistry } from '../registry.js';
import { DefaultChangeRouter } from '../router.js';
import { InMemoryChangeSink } from '../sink.js';
import { buildLiveProjector, createSubscription } from '../subscription.js';
import type { Delta, Subscription } from '../types.js';

const TABLE = 'pgbase_live_widgets';
const PUBLICATION = 'pgbase_live_widgets_pub';
const SLOT = 'pgbase_live_widgets_slot';

interface Claims {
  readonly tenant: string;
}

const widgetPolicy: Policy<any, any, Claims> = definePolicy<
  { id: number; tenant: string; status: string; score: number; secret: string },
  Claims
>('LiveWidget')({
  omit: ['secret'],
  rls: (claims) => ({ tenant: claims.tenant }),
});

let pool: Pool;
let model: ResolvedModel;
let leader: WalLeader;
let sink: InMemoryChangeSink;
let registry: InMemorySubscriptionRegistry;
let router: DefaultChangeRouter;
const stores = new Map<string, ClientStore>();

beforeAll(async () => {
  pool = createTestPool();
  await pool.query(`DROP TABLE IF EXISTS "${TABLE}"`);
  await pool.query(`
    CREATE TABLE "${TABLE}" (
      id integer PRIMARY KEY,
      tenant text NOT NULL,
      status text NOT NULL,
      score integer NOT NULL,
      secret text NOT NULL
    )
  `);
  model = await resolveSimpleModel(pool, 'LiveWidget', TABLE, [
    { name: 'id', required: true },
    { name: 'tenant', required: true },
    { name: 'status', required: true },
    { name: 'score', required: true },
    { name: 'secret', required: true },
  ]);
  const schema = schemaOf(model, PUBLICATION);

  await createPublication(pool, PUBLICATION, [TABLE]);
  leader = createWalLeader(
    { pool, replicationConfig: WAL_REPLICATION_CONFIG, schema },
    { slotName: SLOT, publication: PUBLICATION, acquireRetryMs: 100, statusIntervalMs: 500 },
  );

  registry = new InMemorySubscriptionRegistry();
  router = new DefaultChangeRouter(registry);
  sink = new InMemoryChangeSink({ maxQueued: 10_000, onOverflow: 'resync' });
  leader.on((event) => sink.push(event));
  sink.onEvent((event) => {
    const result =
      event.type === 'change' ? router.route(event.change) : router.routeResync(event.resync);
    for (const delta of result.deltas) stores.get(delta.subscriptionId)?.apply(delta);
  });

  await leader.start();
  await waitFor(() => leader.stats.state === 'streaming');
}, 60_000);

afterAll(async () => {
  await leader?.stop();
  if (pool) {
    await dropPublication(pool, PUBLICATION);
    await dropSlotIfExists(pool, SLOT);
    await pool.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    await pool.end();
  }
});

// ── subscriber wiring: applies deltas the same way a socket-side client store would ───────────

interface ClientStore {
  readonly state: Map<number, unknown>;
  readonly resyncs: Delta[];
  /** Every delta this subscriber was sent — lets a test assert nothing arrived at all. */
  readonly applied: Delta[];
  apply(delta: Delta): void;
}

function newStore(): ClientStore {
  const state = new Map<number, unknown>();
  const resyncs: Delta[] = [];
  const applied: Delta[] = [];
  return {
    state,
    resyncs,
    applied,
    apply(delta: Delta) {
      applied.push(delta);
      if (delta.kind === 'upsert') {
        state.set((delta.row as { id: number }).id, delta.row);
      } else if (delta.kind === 'remove') {
        state.delete((delta.key as { id: number }).id);
      } else {
        resyncs.push(delta);
      }
    },
  };
}

function predicateFor(claims: Claims, clientWhere: Record<string, unknown>) {
  const filterable = computeFilterable(model, widgetPolicy).filterable;
  return normalize(scopedWhere(widgetPolicy, claims, clientWhere), model, filterable);
}

function buildSubscription(
  id: string,
  claims: Claims,
  clientWhere: Record<string, unknown>,
): Subscription {
  return createSubscription({ id, model, policy: widgetPolicy, claims, where: clientWhere });
}

function wireStore(subscription: Subscription): ClientStore & { dispose(): void } {
  const store = newStore();
  stores.set(subscription.id, store);
  const unsub = registry.add(subscription);
  return Object.assign(store, {
    dispose: () => {
      unsub();
      stores.delete(subscription.id);
    },
  });
}

/** What a read (RLS + client filter, same predicate) returns right now, projected the same way. */
async function readSnapshot(claims: Claims, clientWhere: Record<string, unknown>) {
  const { text, values } = compileSql(predicateFor(claims, clientWhere));
  const { rows } = await pool.query(`SELECT * FROM "${TABLE}" WHERE ${text}`, [...values]);
  const project = buildLiveProjector(model, widgetPolicy);
  const out = new Map<number, unknown>();
  for (const row of rows) {
    const view = project(row) as { id: number };
    out.set(view.id, view);
  }
  return out;
}

async function waitForLsn(): Promise<void> {
  const before = leader.stats.lastLsn;
  await waitFor(() => leader.stats.lastLsn !== before, 10_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('convergence: applying deltas equals a read with the same predicate', () => {
  for (const identity of ['DEFAULT', 'FULL'] as const) {
    it(`holds under REPLICA IDENTITY ${identity}`, async () => {
      await pool.query(`ALTER TABLE "${TABLE}" REPLICA IDENTITY ${identity}`);
      const claims: Claims = { tenant: `conv-${identity}` };
      const sub = buildSubscription(`sub-conv-${identity}`, claims, { status: 'ACTIVE' });
      const store = wireStore(sub);

      const base = identity === 'DEFAULT' ? 1000 : 2000;
      async function run(sql: string): Promise<void> {
        await pool.query(sql);
        await waitForLsn();
      }

      try {
        await run(
          `INSERT INTO "${TABLE}" VALUES (${base + 1}, '${claims.tenant}', 'ACTIVE', 5, 's')`,
        );
        await run(
          `INSERT INTO "${TABLE}" VALUES (${base + 2}, '${claims.tenant}', 'INACTIVE', 5, 's')`,
        );
        await run(`INSERT INTO "${TABLE}" VALUES (${base + 3}, 'other-tenant', 'ACTIVE', 5, 's')`);
        // Moves INTO the predicate's range.
        await run(`UPDATE "${TABLE}" SET status = 'ACTIVE' WHERE id = ${base + 2}`);
        // Moves OUT of the predicate's range.
        await run(`UPDATE "${TABLE}" SET status = 'INACTIVE' WHERE id = ${base + 1}`);
        // Stays in range, other column changes.
        await run(`UPDATE "${TABLE}" SET score = 99 WHERE id = ${base + 2}`);
        // Never in range — delete is a no-op for this subscriber.
        await run(`DELETE FROM "${TABLE}" WHERE id = ${base + 3}`);
        // In range, then deleted.
        await run(
          `INSERT INTO "${TABLE}" VALUES (${base + 4}, '${claims.tenant}', 'ACTIVE', 1, 's')`,
        );
        await run(`DELETE FROM "${TABLE}" WHERE id = ${base + 4}`);
        // Back into range.
        await run(`UPDATE "${TABLE}" SET status = 'ACTIVE' WHERE id = ${base + 1}`);
        // Leaves range and STAYS gone. Every other out-of-range move above is undone before the
        // assertion, so without this row the suite passes even if the router never emits `remove`
        // on leave — which is the single property this whole phase rests on.
        await run(
          `INSERT INTO "${TABLE}" VALUES (${base + 5}, '${claims.tenant}', 'ACTIVE', 7, 's')`,
        );
        await run(`UPDATE "${TABLE}" SET status = 'INACTIVE' WHERE id = ${base + 5}`);

        expect(store.resyncs).toEqual([]);

        const expected = await readSnapshot(claims, { status: 'ACTIVE' });
        expect(store.state).toEqual(expected);
        expect([...store.state.keys()].sort()).toEqual([base + 1, base + 2]);
      } finally {
        store.dispose();
      }
    });
  }
});

describe('RLS holds on the live path', () => {
  /**
   * Re-parenting a row across tenants is the one case where the replica identity changes the
   * OUTCOME, not just the cost. Deciding it needs to know whether the subscriber held the row
   * before the update, and only a pre-image can say. Both halves are asserted because the DEFAULT
   * behaviour is a deliberate trade, not an oversight: a `remove` names a primary key, so emitting
   * one defensively would disclose the existence and write timing of another tenant's rows.
   */
  for (const identity of ['FULL', 'DEFAULT'] as const) {
    it(`each subscription sees only its own rows — REPLICA IDENTITY ${identity}`, async () => {
      await pool.query(`ALTER TABLE "${TABLE}" REPLICA IDENTITY ${identity}`);
      // The walsender caches relation metadata and only re-sends it when it next sees the table.
      // Without a throwaway write to force that, an UPDATE decoded moments after the ALTER can
      // still carry the previous identity's pre-image, which changes the outcome asserted below.
      await pool.query(`INSERT INTO "${TABLE}" VALUES (5090, 'rls-warm', 'ACTIVE', 0, 'x')`);
      await waitForLsn();
      await pool.query(`UPDATE "${TABLE}" SET score = 1 WHERE id = 5090`);
      await waitForLsn();
      await pool.query(`DELETE FROM "${TABLE}" WHERE id = 5090`);
      await waitForLsn();

      const id = identity === 'FULL' ? 5001 : 5002;
      const subA = buildSubscription(`sub-rls-a-${identity}`, { tenant: 'rls-A' }, {});
      const subB = buildSubscription(`sub-rls-b-${identity}`, { tenant: 'rls-B' }, {});
      const storeA = wireStore(subA);
      const storeB = wireStore(subB);

      try {
        await pool.query(`INSERT INTO "${TABLE}" VALUES (${id}, 'rls-A', 'ACTIVE', 1, 'shh')`);
        await waitForLsn();

        expect([...storeA.state.values()]).toEqual([
          { id, tenant: 'rls-A', status: 'ACTIVE', score: 1 },
        ]);
        expect(storeB.state.size).toBe(0);

        await pool.query(`UPDATE "${TABLE}" SET tenant = 'rls-B' WHERE id = ${id}`);
        await waitForLsn();

        expect([...storeB.state.values()]).toEqual([
          { id, tenant: 'rls-B', status: 'ACTIVE', score: 1 },
        ]);

        if (identity === 'FULL') {
          expect(storeA.state.size).toBe(0);
        } else {
          expect(storeA.state.size).toBe(1);
        }

        for (const row of [...storeA.state.values(), ...storeB.state.values()]) {
          expect('secret' in (row as object)).toBe(false);
        }
      } finally {
        storeA.dispose();
        storeB.dispose();
        await pool.query(`DELETE FROM "${TABLE}" WHERE id = ${id}`);
      }
    });
  }

  it('a write in another tenant never names a row to a subscriber who cannot read it', async () => {
    await pool.query(`ALTER TABLE "${TABLE}" REPLICA IDENTITY DEFAULT`);
    // Drain anything an earlier test left in flight, so a late delta cannot be mistaken for a leak.
    await pool.query(`INSERT INTO "${TABLE}" VALUES (5099, 'rls-drain', 'ACTIVE', 0, 'x')`);
    await waitForLsn();
    await pool.query(`DELETE FROM "${TABLE}" WHERE id = 5099`);
    await waitForLsn();

    const outsider = buildSubscription('sub-rls-outsider', { tenant: 'rls-C' }, {});
    const store = wireStore(outsider);
    try {
      await pool.query(`INSERT INTO "${TABLE}" VALUES (5003, 'rls-D', 'ACTIVE', 1, 'shh')`);
      await waitForLsn();
      await pool.query(`UPDATE "${TABLE}" SET score = 42 WHERE id = 5003`);
      await waitForLsn();
      await pool.query(`UPDATE "${TABLE}" SET status = 'INACTIVE' WHERE id = 5003`);
      await waitForLsn();

      // Not just "the cache is right" — nothing was delivered at all. A `remove` here would have
      // told this subscriber that row 5003 exists and is being written to.
      expect(store.state.size).toBe(0);
      expect(store.resyncs).toEqual([]);
      expect(store.applied).toEqual([]);
    } finally {
      store.dispose();
      await pool.query(`DELETE FROM "${TABLE}" WHERE id = 5003`);
    }
  });
});
