import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPool } from '../../schema/test-support.js';
import type { ResolvedModel } from '../../schema/types.js';
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

const TABLE = 'pgbase_wal_events';
const ENUM_TYPE = 'pgbase_wal_events_status';
const PUBLICATION = 'pgbase_wal_events_pub';
const SLOT = 'pgbase_wal_events_slot';

let pool: Pool;
let model: ResolvedModel;
let leader: WalLeader;
const events: WalEvent[] = [];

function changes(): ChangeEvent[] {
  return events
    .filter((e): e is { type: 'change'; change: ChangeEvent } => e.type === 'change')
    .map((e) => e.change);
}

beforeAll(async () => {
  pool = createTestPool();
  await pool.query(`DROP TABLE IF EXISTS "${TABLE}"`);
  await pool.query(`DROP TYPE IF EXISTS "${ENUM_TYPE}" CASCADE`);
  await pool.query(`CREATE TYPE "${ENUM_TYPE}" AS ENUM ('QUEUED', 'RUNNING', 'DONE')`);
  await pool.query(`
    CREATE TABLE "${TABLE}" (
      id integer PRIMARY KEY,
      name text NOT NULL,
      status "${ENUM_TYPE}" NOT NULL,
      tags text[] NOT NULL,
      note text
    )
  `);

  const enums = [{ name: 'Status', dbName: ENUM_TYPE, values: ['QUEUED', 'RUNNING', 'DONE'] }];
  model = await resolveSimpleModel(
    pool,
    'WalEvent',
    TABLE,
    [
      { name: 'id', required: true },
      { name: 'name', required: true },
      { name: 'status', required: true, enumName: 'Status' },
      { name: 'tags', required: true, isList: true },
      { name: 'note', required: false },
    ],
    { enums },
  );
  const schema = schemaOf(model, PUBLICATION, enums);

  await createPublication(pool, PUBLICATION, [TABLE]);
  leader = createWalLeader(
    { pool, replicationConfig: WAL_REPLICATION_CONFIG, schema },
    { slotName: SLOT, publication: PUBLICATION, acquireRetryMs: 100, statusIntervalMs: 500 },
  );
  leader.on((e) => events.push(e));
  await leader.start();
  await waitFor(() => leader.stats.state === 'streaming');
}, 60_000);

afterAll(async () => {
  await leader?.stop();
  if (pool) {
    await dropPublication(pool, PUBLICATION);
    await dropSlotIfExists(pool, SLOT);
    await pool.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    await pool.query(`DROP TYPE IF EXISTS "${ENUM_TYPE}" CASCADE`);
    await pool.end();
  }
});

describe('insert/update/delete round trip', () => {
  it('insert: full new image, null oldRow, enum + array decode correctly', async () => {
    const before = changes().length;
    await pool.query(
      `INSERT INTO "${TABLE}" (id, name, status, tags, note) VALUES (1, 'alpha', 'QUEUED', ARRAY['a','b'], NULL)`,
    );
    await waitFor(() => changes().length > before);
    const change = changes().at(-1)!;

    expect(change.kind).toBe('insert');
    expect(change.oldRow).toBeNull();
    expect(change.newRow).toEqual({
      id: 1,
      name: 'alpha',
      status: 'QUEUED',
      tags: ['a', 'b'],
      note: null,
    });
    expect(change.unknownColumns.size).toBe(0);

    // NULL vs absent: the column IS present, decoded to a real `null`, not merely missing.
    expect('note' in change.newRow!).toBe(true);
    expect(change.newRow!.note).toBeNull();
  });

  it('update under REPLICA IDENTITY DEFAULT (the default): key-only pre-image', async () => {
    const before = changes().length;
    await pool.query(`UPDATE "${TABLE}" SET name = 'alpha-2', status = 'RUNNING' WHERE id = 1`);
    await waitFor(() => changes().length > before);
    const change = changes().at(-1)!;

    expect(change.kind).toBe('update');
    expect(change.newRow).toEqual({
      id: 1,
      name: 'alpha-2',
      status: 'RUNNING',
      tags: ['a', 'b'],
      note: null,
    });
    // Only the identity column travels — not the columns that actually changed, and not the ones
    // that didn't.
    expect(change.oldRow).toEqual({ id: 1 });
  });

  it('update under REPLICA IDENTITY FULL: full pre-image with the previous values', async () => {
    await pool.query(`ALTER TABLE "${TABLE}" REPLICA IDENTITY FULL`);
    const before = changes().length;
    await pool.query(`UPDATE "${TABLE}" SET tags = ARRAY['c'] WHERE id = 1`);
    await waitFor(() => changes().length > before);
    const change = changes().at(-1)!;

    expect(change.kind).toBe('update');
    expect(change.oldRow).toEqual({
      id: 1,
      name: 'alpha-2',
      status: 'RUNNING',
      tags: ['a', 'b'],
      note: null,
    });
    expect(change.newRow).toEqual({
      id: 1,
      name: 'alpha-2',
      status: 'RUNNING',
      tags: ['c'],
      note: null,
    });
  });

  it('delete under REPLICA IDENTITY FULL: null newRow, full oldRow', async () => {
    const before = changes().length;
    await pool.query(`DELETE FROM "${TABLE}" WHERE id = 1`);
    await waitFor(() => changes().length > before);
    const change = changes().at(-1)!;

    expect(change.kind).toBe('delete');
    expect(change.newRow).toBeNull();
    expect(change.oldRow).toEqual({
      id: 1,
      name: 'alpha-2',
      status: 'RUNNING',
      tags: ['c'],
      note: null,
    });
  });

  it('delete under REPLICA IDENTITY DEFAULT: key-only oldRow', async () => {
    await pool.query(`ALTER TABLE "${TABLE}" REPLICA IDENTITY DEFAULT`);
    await pool.query(
      `INSERT INTO "${TABLE}" (id, name, status, tags, note) VALUES (2, 'beta', 'DONE', ARRAY[]::text[], 'hi')`,
    );
    await waitFor(() => changes().some((c) => c.kind === 'insert' && c.newRow?.id === 2));

    const before = changes().length;
    await pool.query(`DELETE FROM "${TABLE}" WHERE id = 2`);
    await waitFor(() => changes().length > before);
    const change = changes().at(-1)!;

    expect(change.kind).toBe('delete');
    expect(change.newRow).toBeNull();
    expect(change.oldRow).toEqual({ id: 2 });
  });

  it('a multi-statement transaction emits changes in commit order, all sharing one commitLsn', async () => {
    const before = changes().length;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO "${TABLE}" (id, name, status, tags, note) VALUES (10, 'x', 'QUEUED', ARRAY[]::text[], NULL)`,
      );
      await client.query(`UPDATE "${TABLE}" SET status = 'RUNNING' WHERE id = 10`);
      await client.query(
        `INSERT INTO "${TABLE}" (id, name, status, tags, note) VALUES (11, 'y', 'QUEUED', ARRAY[]::text[], NULL)`,
      );
      await client.query(`UPDATE "${TABLE}" SET status = 'DONE' WHERE id = 10`);
      await client.query(`DELETE FROM "${TABLE}" WHERE id = 11`);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    await waitFor(() => changes().length >= before + 5);

    const txChanges = changes().slice(-5);
    expect(txChanges.map((c) => [c.kind, c.newRow?.id ?? c.oldRow?.id])).toEqual([
      ['insert', 10],
      ['update', 10],
      ['insert', 11],
      ['update', 10],
      ['delete', 11],
    ]);
    const commitLsns = new Set(txChanges.map((c) => c.commitLsn));
    expect(commitLsns.size).toBe(1);
  });
});
