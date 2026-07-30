import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPool } from '../../schema/test-support.js';
import type { ResolvedModel, ResolvedSchema } from '../../schema/types.js';
import { createWalLeader } from '../leader.js';
import type { ChangeEvent, WalEvent, WalLeader } from '../types.js';
import { resolveSimpleModel, schemaOf } from './simple-model.js';
import {
  WAL_REPLICATION_CONFIG,
  createPublication,
  dropPublication,
  dropSlotIfExists,
  waitFor,
} from './support.js';

const TABLE = 'pgbase_wal_failover';
const PUBLICATION = 'pgbase_wal_failover_pub';

let pool: Pool;
let model: ResolvedModel;
let schema: ResolvedSchema;
let nextId = 1;

function freshId(): number {
  return nextId++;
}

function makeLeader(
  slotName: string,
  opts: Partial<{ acquireRetryMs: number; statusIntervalMs: number }> = {},
): WalLeader {
  return createWalLeader(
    { pool, replicationConfig: WAL_REPLICATION_CONFIG, schema },
    {
      slotName,
      publication: PUBLICATION,
      acquireRetryMs: opts.acquireRetryMs ?? 50,
      statusIntervalMs: opts.statusIntervalMs ?? 100,
    },
  );
}

function insertRow(id: number): Promise<unknown> {
  return pool.query(`INSERT INTO "${TABLE}" (id, name) VALUES ($1, 'x')`, [id]);
}

function collect(leader: WalLeader): ChangeEvent[] {
  const out: ChangeEvent[] = [];
  leader.on((e: WalEvent) => {
    if (e.type === 'change') out.push(e.change);
  });
  return out;
}

async function stopAll(...leaders: WalLeader[]): Promise<void> {
  await Promise.all(leaders.map((l) => l.stop().catch(() => {})));
}

beforeAll(async () => {
  pool = createTestPool();
  await pool.query(`DROP TABLE IF EXISTS "${TABLE}"`);
  await pool.query(`CREATE TABLE "${TABLE}" (id integer PRIMARY KEY, name text NOT NULL)`);
  model = await resolveSimpleModel(pool, 'WalFailover', TABLE, [
    { name: 'id', required: true },
    { name: 'name', required: true },
  ]);
  schema = schemaOf(model, PUBLICATION);
  await createPublication(pool, PUBLICATION, [TABLE]);
}, 60_000);

afterAll(async () => {
  if (pool) {
    await dropPublication(pool, PUBLICATION);
    await pool.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    await pool.end();
  }
});

describe('leader election and failover', () => {
  it('two leaders, one slot: the second sits in acquiring and takes over quickly when the first stops', async () => {
    const slot = 'pgbase_wal_failover_slot_1';
    const a = makeLeader(slot);
    const b = makeLeader(slot);
    try {
      await a.start();
      await waitFor(() => a.stats.state === 'streaming');

      await b.start();
      // Postgres enforces exclusivity itself — b's first attach attempt fails immediately and it
      // sits retrying, never touching the stream while a is alive.
      await waitFor(() => b.stats.acquireAttempts >= 1);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(b.stats.state).not.toBe('streaming');

      const handoverStart = Date.now();
      await a.stop();
      await waitFor(() => b.stats.state === 'streaming', 5_000);
      const handoverMs = Date.now() - handoverStart;

      // The whole point: this is the rolling-deploy case, not the SIGKILL case — it must not be
      // anywhere near wal_sender_timeout's tens of seconds.
      expect(handoverMs).toBeLessThan(2_000);
    } finally {
      await stopAll(a, b);
      await dropSlotIfExists(pool, slot);
    }
  });

  it('takeover preserves the LSN position: changes across the handover gap are delivered exactly once, none dropped', async () => {
    const slot = 'pgbase_wal_failover_slot_2';
    const a = makeLeader(slot);
    const b = makeLeader(slot);
    const aChanges = collect(a);
    const bChanges = collect(b);
    try {
      await a.start();
      await waitFor(() => a.stats.state === 'streaming');

      const id1 = freshId();
      await insertRow(id1);
      await waitFor(() => aChanges.some((c) => c.newRow?.id === id1));

      // b joins while a is still healthy — stays parked.
      await b.start();
      await waitFor(() => b.stats.acquireAttempts >= 1);

      const id2 = freshId();
      await insertRow(id2);
      await waitFor(() => aChanges.some((c) => c.newRow?.id === id2));

      // Trigger handover, and write a row right around the gap itself.
      const stopPromise = a.stop();
      const id3 = freshId();
      await insertRow(id3);
      await stopPromise;

      await waitFor(() => b.stats.state === 'streaming', 5_000);
      await waitFor(
        () =>
          bChanges.some((c) => c.newRow?.id === id3) || aChanges.some((c) => c.newRow?.id === id3),
        5_000,
      );

      const allIds = [...aChanges, ...bChanges].map((c) => c.newRow?.id);
      // Every id observed exactly once across the combined stream of both leaders — no drops,
      // no duplicates, regardless of which of the two happened to deliver it.
      for (const id of [id1, id2, id3]) {
        expect(
          allIds.filter((x) => x === id),
          `row id=${id}`,
        ).toHaveLength(1);
      }
    } finally {
      await stopAll(a, b);
      await dropSlotIfExists(pool, slot);
    }
  });

  it('a third instance joining while a leader is healthy stays in acquiring and never double-consumes', async () => {
    const slot = 'pgbase_wal_failover_slot_3';
    const a = makeLeader(slot);
    const c = makeLeader(slot);
    const cChanges = collect(c);
    try {
      await a.start();
      await waitFor(() => a.stats.state === 'streaming');

      await c.start();
      await waitFor(() => c.stats.acquireAttempts >= 2, 3_000);
      expect(c.stats.state).not.toBe('streaming');

      const id = freshId();
      await insertRow(id);
      await new Promise((resolve) => setTimeout(resolve, 500));
      // c never attached, so it must never have seen this change — the double-consumption this
      // guards against.
      expect(cChanges).toHaveLength(0);
    } finally {
      await stopAll(a, c);
      await dropSlotIfExists(pool, slot);
    }
  });

  it('clean stop() leaves the slot present but inactive — never dropped', async () => {
    const slot = 'pgbase_wal_failover_slot_4';
    const a = makeLeader(slot);
    try {
      await a.start();
      await waitFor(() => a.stats.state === 'streaming');
      await a.stop();

      const { rows } = await pool.query<{ active: boolean }>(
        'SELECT active FROM pg_replication_slots WHERE slot_name = $1',
        [slot],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.active).toBe(false);
    } finally {
      await dropSlotIfExists(pool, slot);
    }
  });

  it('restart resumes from the confirmed LSN: no replay of acknowledged changes, no drop of unacknowledged ones', async () => {
    const slot = 'pgbase_wal_failover_slot_5';
    let a: WalLeader = makeLeader(slot, { statusIntervalMs: 100 });
    let aChanges = collect(a);
    try {
      await a.start();
      await waitFor(() => a.stats.state === 'streaming');

      const idAcked = freshId();
      await insertRow(idAcked);
      await waitFor(() => aChanges.some((c) => c.newRow?.id === idAcked));
      // Give the status interval time to actually acknowledge this commit's LSN before we stop.
      await new Promise((resolve) => setTimeout(resolve, 400));

      await a.stop();

      // Written while genuinely detached — must not be lost.
      const idDuringGap = freshId();
      await insertRow(idDuringGap);

      a = makeLeader(slot, { statusIntervalMs: 100 });
      aChanges = collect(a);
      await a.start();
      await waitFor(() => a.stats.state === 'streaming');
      await waitFor(() => aChanges.some((c) => c.newRow?.id === idDuringGap), 5_000);

      // The acknowledged row must not have been replayed on top of the new leader.
      expect(aChanges.filter((c) => c.newRow?.id === idAcked)).toHaveLength(0);
      expect(aChanges.filter((c) => c.newRow?.id === idDuringGap)).toHaveLength(1);
    } finally {
      await a.stop().catch(() => {});
      await dropSlotIfExists(pool, slot);
    }
  });

  it('an invalidated (or externally dropped) slot is recreated on the next attach, with a slot-recreated resync', async () => {
    const slot = 'pgbase_wal_failover_slot_6';
    const a = makeLeader(slot, { acquireRetryMs: 100 });
    const events: WalEvent[] = [];
    a.on((e) => events.push(e));
    try {
      await a.start();
      await waitFor(() => a.stats.state === 'streaming');
      await a.stop();

      // Simulate invalidation: the slot is simply gone when the leader next looks for it (the
      // same code path `wal_status = 'lost'` takes — see `recreateSlotIfInvalidated`).
      await pool.query('SELECT pg_drop_replication_slot($1)', [slot]);

      await a.start();
      await waitFor(() => a.stats.state === 'streaming', 5_000);

      const resync = events.find(
        (e) => e.type === 'resync' && e.resync.reason === 'slot-recreated',
      );
      expect(resync).toBeDefined();

      // And it actually works afterwards — not just recreated-and-stuck.
      const id = freshId();
      const before = events.filter((e) => e.type === 'change').length;
      await insertRow(id);
      await waitFor(() => events.filter((e) => e.type === 'change').length > before);
    } finally {
      await a.stop().catch(() => {});
      await dropSlotIfExists(pool, slot);
    }
  });
});
