import type { Client, Pool } from 'pg';
import { LogicalReplicationService } from 'pg-logical-replication';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPool } from '../../schema/test-support.js';
import type { ResolvedModel } from '../../schema/types.js';
import { createWalLeader } from '../leader.js';
import { TOAST_UNCHANGED, type PgoutputMessage, type UpdateMessage } from '../pgoutput-messages.js';
import { PgoutputDecoder } from '../pgoutput.js';
import type { ChangeEvent, WalLeader } from '../types.js';
import { resolveSimpleModel, schemaOf } from './simple-model.js';
import {
  WAL_REPLICATION_CONFIG,
  createPublication,
  dropPublication,
  dropSlotIfExists,
  waitFor,
} from './support.js';

const TABLE = 'pgbase_wal_toast';
const PUBLICATION = 'pgbase_wal_toast_pub';
const LEADER_SLOT = 'pgbase_wal_toast_leader_slot';
const RAW_SLOT = 'pgbase_wal_toast_raw_slot';

// Random and incompressible: a repeated-character string compresses below the ~2KB TOAST
// threshold and stays inline, which would defeat the entire point of this test.
function randomBigText(n: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

const BIG_VALUE = randomBigText(8_000);

let pool: Pool;
let model: ResolvedModel;
let leader: WalLeader;
const changeEvents: ChangeEvent[] = [];

/** A second, throwaway consumer that decodes with nothing but `PgoutputDecoder` — no
 * TOAST-carry-forward, no `unknownColumns` bookkeeping — so what it captures is exactly the wire
 * bytes the higher-level `WalLeader` test below is interpreting. */
class RawCapturePlugin {
  readonly options: { readonly publication: string };
  private readonly decoder = new PgoutputDecoder();
  constructor(publication: string) {
    this.options = { publication };
  }
  get name(): string {
    return 'pgoutput-raw-capture';
  }
  parse(buffer: Buffer): PgoutputMessage {
    return this.decoder.parse(buffer);
  }
  start(client: Client, slotName: string, lastLsn: string): Promise<unknown> {
    const options = [
      `proto_version '1'`,
      `publication_names '${this.options.publication}'`,
      `messages 'false'`,
    ];
    return client.query(
      `START_REPLICATION SLOT "${slotName}" LOGICAL ${lastLsn} (${options.join(', ')})`,
    );
  }
}

async function captureNextUpdate(action: () => Promise<void>): Promise<UpdateMessage> {
  await pool.query('SELECT pg_create_logical_replication_slot($1, $2)', [RAW_SLOT, 'pgoutput']);
  const messages: PgoutputMessage[] = [];
  const service = new LogicalReplicationService(WAL_REPLICATION_CONFIG, {
    acknowledge: { auto: true, timeoutSeconds: 0 },
  });
  service.on('data', (_lsn: string, msg: PgoutputMessage) => {
    messages.push(msg);
  });
  service.on('error', () => {});
  try {
    const started = new Promise<void>((resolve) => service.once('start', () => resolve()));
    const subscribed = service.subscribe(
      new RawCapturePlugin(PUBLICATION) as never,
      RAW_SLOT,
      '0/00000000',
    );
    subscribed.catch(() => {});
    await started;
    await action();
    await waitFor(() => messages.some((m) => m.tag === 'update'), 10_000);
  } finally {
    await service.stop().catch(() => {});
    await dropSlotIfExists(pool, RAW_SLOT);
  }
  const update = messages.find((m): m is UpdateMessage => m.tag === 'update');
  if (!update) throw new Error('captureNextUpdate: no update message observed');
  return update;
}

beforeAll(async () => {
  pool = createTestPool();
  await pool.query(`DROP TABLE IF EXISTS "${TABLE}"`);
  await pool.query(
    `CREATE TABLE "${TABLE}" (id integer PRIMARY KEY, big text, tag integer NOT NULL)`,
  );
  model = await resolveSimpleModel(pool, 'WalToast', TABLE, [
    { name: 'id', required: true },
    { name: 'big', required: false },
    { name: 'tag', required: true },
  ]);

  await createPublication(pool, PUBLICATION, [TABLE]);
  await pool.query(`INSERT INTO "${TABLE}" (id, big, tag) VALUES (1, $1, 1)`, [BIG_VALUE]);

  // Prove the value actually went out-of-line before trusting anything else in this file — a
  // repeated-character or short value would silently make every assertion below vacuous.
  // `pg_column_size`/`length` both transparently detoast, so they can't tell inline from
  // external; the toast side-table's chunk rows are the only direct evidence.
  const { rows: toastRelRows } = await pool.query<{ toastrel: string }>(
    `SELECT reltoastrelid::regclass::text AS toastrel FROM pg_class WHERE relname = $1`,
    [TABLE],
  );
  const { rows: chunkRows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${toastRelRows[0]!.toastrel}`,
  );
  expect(chunkRows[0]!.n, 'fixture value must actually be TOASTed out-of-line').toBeGreaterThan(0);

  const schema = schemaOf(model, PUBLICATION);
  leader = createWalLeader(
    { pool, replicationConfig: WAL_REPLICATION_CONFIG, schema },
    { slotName: LEADER_SLOT, publication: PUBLICATION, acquireRetryMs: 100, statusIntervalMs: 500 },
  );
  leader.on((e) => {
    if (e.type === 'change') changeEvents.push(e.change);
  });
  await leader.start();
  await waitFor(() => leader.stats.state === 'streaming');
}, 60_000);

afterAll(async () => {
  await leader?.stop();
  if (pool) {
    await dropPublication(pool, PUBLICATION);
    await dropSlotIfExists(pool, LEADER_SLOT);
    await dropSlotIfExists(pool, RAW_SLOT);
    await pool.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    await pool.end();
  }
});

describe('TOAST: unchanged out-of-line value', () => {
  it("the wire marks the untouched column with pgoutput's 'u' unchanged-TOAST byte, not the value", async () => {
    const update = await captureNextUpdate(async () => {
      await pool.query(`UPDATE "${TABLE}" SET tag = 2 WHERE id = 1`);
    });
    expect(update.new.tag).toBe('2');
    // This is the marker itself — pgoutput sent kind byte 0x75 ('u') for this attribute instead
    // of its (unchanged, large) text. `TOAST_UNCHANGED` is the sentinel `pgoutput.ts` uses to
    // carry that fact forward without ever confusing it with SQL NULL (kind 'n') or absence.
    expect(update.new.big).toBe(TOAST_UNCHANGED);
  });

  it('without REPLICA IDENTITY FULL: unknown at this LSN — added to unknownColumns, never fabricated as null', async () => {
    const before = changeEvents.length;
    await pool.query(`UPDATE "${TABLE}" SET tag = 3 WHERE id = 1`);
    await waitFor(() => changeEvents.length > before);
    const change = changeEvents.at(-1)!;

    expect(change.kind).toBe('update');
    expect(change.newRow!.tag).toBe(3);
    expect(change.unknownColumns.has('big')).toBe(true);
    // Absent, not null — a fabricated `null` here would be indistinguishable from the column
    // genuinely being SQL NULL, corrupting anything downstream that trusts it.
    expect('big' in change.newRow!).toBe(false);
    // The default-identity pre-image is key-only in the first place, so `big` was never a
    // candidate for carry-forward here — there is no prior value available at this LSN at all.
    expect(change.oldRow).toEqual({ id: 1 });
  });

  it('with REPLICA IDENTITY FULL: the prior value is carried forward into newRow and oldRow', async () => {
    await pool.query(`ALTER TABLE "${TABLE}" REPLICA IDENTITY FULL`);
    const before = changeEvents.length;
    await pool.query(`UPDATE "${TABLE}" SET tag = 4 WHERE id = 1`);
    await waitFor(() => changeEvents.length > before);
    const change = changeEvents.at(-1)!;

    expect(change.kind).toBe('update');
    expect(change.newRow!.tag).toBe(4);
    expect(change.unknownColumns.size).toBe(0);
    expect(change.newRow!.big).toBe(BIG_VALUE);
    expect(change.oldRow!.big).toBe(BIG_VALUE);
  });
});
