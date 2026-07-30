import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENUM_NAME, ENUM_VALUES, ROWS } from '../../query/__tests__/differential-fixture.js';
import { JSON_NULL, OID, coerceValue } from '../../query/compare.js';
import { createTestPool } from '../../schema/test-support.js';
import type { ResolvedField, ResolvedModel, ResolvedSchema } from '../../schema/types.js';
import { SCHEMA_FORMAT_VERSION } from '../../version.js';
import { parsePgArrayLiteral } from '../decode.js';
import { createWalLeader } from '../leader.js';
import type { ChangeEvent, WalLeader } from '../types.js';
import {
  WAL_FIXTURE_ENUM_TYPE as ENUM_TYPE,
  WAL_FIXTURE_TABLE as TABLE,
  createWalFixtureTable,
  dropWalFixtureTable,
  insertWalFixtureRow,
} from './fixture.js';
import {
  WAL_REPLICATION_CONFIG,
  createPublication,
  dropPublication,
  dropSlotIfExists,
  waitFor,
} from './support.js';

const PUBLICATION = 'pgbase_wal_agreement_pub';
const SLOT = 'pgbase_wal_agreement_slot';

// Timestamp columns carry the leader's one *known, deliberate* divergence from a plain SQL/Prisma
// read (see the assertions below) — excluded from the blanket equality loop and checked on their
// own terms instead.
const TIMESTAMP_COLUMNS = new Set(['c_ts', 'c_ts_n', 'c_tstz', 'c_tstz_n']);

let pool: Pool;
let model: ResolvedModel;
let leader: WalLeader;
const changesByRowId = new Map<number, ChangeEvent>();

/** The "snapshot" path: an ordinary `pool.query` (node-postgres's default `pg-types@2.x` parsing
 * — the version `pg` bundles for its own out-of-the-box decoding, independent of whatever
 * `pg-types` version this package depends on) normalized into `compare.ts`'s canonical
 * representation via `coerceValue`. A genuinely independent decode from the WAL path in
 * `decode.ts`: different code, different wire representation, same target representation.
 *
 * FINDING: node-postgres's bundled parser registers `date` and `timestamp` (no time zone) to the
 * *raw* `postgres-date` parser with no 'Z' appended — unlike `timestamptz`, whose wire text always
 * carries an explicit offset. With no offset in the text at all, `postgres-date` falls back to
 * the **local-timezone** `Date(y, m, d, h, mi, s, ms)` constructor, so `date.getTime()` is
 * silently host-timezone-dependent for these two types. `compare.ts`'s `coerceTimestamp` (and by
 * extension `coerceValue`) trusts `getTime()`, which is only safe for tz-aware wire text. This
 * reconstructs the intended wall-clock value from `Date`'s *local* getters instead — the portable
 * fix — precisely to keep this test deterministic on a non-UTC host (this one runs America/New_York). */
function snapshotDecode(field: ResolvedField, raw: unknown): unknown {
  if (raw === null) return null;
  if (field.elementTypeOid !== null) {
    // node-postgres's bundled parser only splits array literals for a static table of built-in
    // array OIDs — a user-defined enum's array type isn't in it, so it comes back as the
    // unparsed `{a,b}` string. A second, smaller finding: reported alongside the others.
    const elements: readonly (string | null)[] = Array.isArray(raw)
      ? (raw as readonly (string | null)[])
      : parsePgArrayLiteral(raw as string, null);
    return elements.map((el) =>
      el === null
        ? null
        : coerceValue(field.elementTypeOid!, null, el, field.column, field.enumValues),
    );
  }
  if (field.typeOid === OID.DATE && raw instanceof Date) {
    const y = raw.getFullYear().toString().padStart(4, '0');
    const mo = (raw.getMonth() + 1).toString().padStart(2, '0');
    const d = raw.getDate().toString().padStart(2, '0');
    return coerceValue(OID.DATE, null, `${y}-${mo}-${d}`, field.column, field.enumValues);
  }
  return coerceValue(field.typeOid, null, raw, field.column, field.enumValues);
}

/** The value an app actually gets from `coerceValue` for a `timestamp` (no tz) column — silently
 * host-timezone-dependent, per the FINDING above. Used only to demonstrate the divergence. */
function naiveDateMicros(date: Date): bigint {
  return BigInt(date.getTime()) * 1000n;
}

/** The intended wall-clock value, recovered portably via local getters. */
function correctedLocalDateMicros(date: Date): bigint {
  const ms = Date.UTC(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  );
  return BigInt(ms) * 1000n;
}

beforeAll(async () => {
  pool = createTestPool();
  model = await createWalFixtureTable(pool);

  const schema: ResolvedSchema = {
    formatVersion: SCHEMA_FORMAT_VERSION,
    publication: PUBLICATION,
    models: [model],
    enums: [{ name: ENUM_NAME, dbName: ENUM_TYPE, values: [...ENUM_VALUES] }],
    byModel: new Map([[model.model, model]]),
    byTable: new Map([[`${model.namespace}.${model.table}`, model]]),
  };

  await createPublication(pool, PUBLICATION, [TABLE]);
  leader = createWalLeader(
    { pool, replicationConfig: WAL_REPLICATION_CONFIG, schema },
    { slotName: SLOT, publication: PUBLICATION, acquireRetryMs: 100, statusIntervalMs: 200 },
  );
  leader.on((event) => {
    if (event.type === 'change' && event.change.kind === 'insert') {
      changesByRowId.set(event.change.newRow!.id as number, event.change);
    }
  });
  await leader.start();
  await waitFor(() => leader.stats.state === 'streaming');

  for (const r of ROWS) await insertWalFixtureRow(pool, model, r);
  await waitFor(() => changesByRowId.size >= ROWS.length, 20_000);
}, 60_000);

afterAll(async () => {
  await leader?.stop();
  if (pool) {
    await dropPublication(pool, PUBLICATION);
    await dropSlotIfExists(pool, SLOT);
    await dropWalFixtureTable(pool);
    await pool.end();
  }
});

describe('WAL decode vs snapshot decode: agreement on every fixture row', () => {
  it('every non-timestamp column matches exactly, for every row', async () => {
    let compared = 0;
    for (const r of ROWS) {
      const change = changesByRowId.get(r.id as number);
      expect(change, `no WAL insert event observed for row id=${r.id}`).toBeDefined();

      const { rows } = await pool.query(`SELECT * FROM "${TABLE}" WHERE id = $1`, [r.id]);
      const dbRow = rows[0] as Record<string, unknown>;

      for (const field of model.fields) {
        if (TIMESTAMP_COLUMNS.has(field.column)) continue;
        const wal = change!.newRow![field.column];
        const snapshot = snapshotDecode(field, dbRow[field.column]);

        // jsonb: a plain SQL read cannot distinguish a stored JSON `null` scalar from a SQL NULL
        // column — both arrive as JS `null` before we ever see them (see the dedicated assertion
        // below). Excluded here as the second, narrower, known divergence.
        if (wal === JSON_NULL) continue;

        compared++;
        expect(wal, `row id=${r.id}, column "${field.column}"`).toEqual(snapshot);
      }
    }
    expect(compared).toBeGreaterThan(0);
  });

  it('FINDING: timestamptz — WAL text carries full microseconds, a plain SQL read does not', async () => {
    // Every fixture timestamp has a non-millisecond-aligned microsecond remainder (see
    // differential-fixture.ts's TS_BASE etc: ".123456"), so this isn't a corner case — it is the
    // typical case for any timestamp not authored at exact millisecond precision.
    let sawSubMillisecondDivergence = false;
    for (const r of ROWS) {
      const change = changesByRowId.get(r.id as number)!;
      for (const column of ['c_tstz', 'c_tstz_n'] as const) {
        const field = model.byColumn.get(column)!;
        const walMicros = change.newRow![column] as bigint | null;
        if (walMicros === null) continue;

        const { rows } = await pool.query(`SELECT "${column}" FROM "${TABLE}" WHERE id = $1`, [
          r.id,
        ]);
        const snapshotMicros = snapshotDecode(field, rows[0][column]) as bigint;

        const remainder = ((walMicros % 1000n) + 1000n) % 1000n;
        // The snapshot path is `Date`-based (millisecond resolution): it always lands on a
        // millisecond boundary.
        expect(snapshotMicros % 1000n, `row id=${r.id}, column "${column}"`).toBe(0n);
        if (remainder !== 0n) {
          sawSubMillisecondDivergence = true;
          expect(
            walMicros,
            `row id=${r.id}, column "${column}" should retain sub-ms precision`,
          ).not.toBe(snapshotMicros);
        }
        // They still agree down to the millisecond — the snapshot path is a truncation of the
        // WAL path, not a different value.
        expect(walMicros - remainder, `row id=${r.id}, column "${column}" ms component`).toBe(
          snapshotMicros,
        );
      }
    }
    expect(sawSubMillisecondDivergence).toBe(true);
  });

  it('FINDING: timestamp (no tz) — a plain SQL read is silently HOST-TIMEZONE-DEPENDENT, not just ms-truncated', async () => {
    // node-postgres's bundled parser has no offset to work with for this type (unlike
    // timestamptz) and falls back to a local-timezone `Date` — see `snapshotDecode`'s doc comment.
    let sawSubMillisecondDivergence = false;
    let sawHostTimezoneDivergence = false;
    let anyHostOffsetIsNonZero = false;
    for (const r of ROWS) {
      const change = changesByRowId.get(r.id as number)!;
      for (const column of ['c_ts', 'c_ts_n'] as const) {
        const walMicros = change.newRow![column] as bigint | null;
        if (walMicros === null) continue;

        const { rows } = await pool.query(`SELECT "${column}" FROM "${TABLE}" WHERE id = $1`, [
          r.id,
        ]);
        const raw = rows[0][column] as Date;
        // What `coerceValue` (and therefore any app calling it on a plain SQL read) actually gets.
        const naive = naiveDateMicros(raw);
        // The wall-clock value, recovered portably regardless of host timezone.
        const corrected = correctedLocalDateMicros(raw);
        const remainder = ((walMicros % 1000n) + 1000n) % 1000n;

        // The portable reconstruction always agrees with the WAL value down to the millisecond.
        expect(corrected, `row id=${r.id}, column "${column}"`).toBe(walMicros - remainder);
        if (remainder !== 0n) sawSubMillisecondDivergence = true;

        // The offset in effect AT THIS INSTANT specifically — not a single fixed reference date.
        // Row 59/60 are pre-epoch (1954), where the historical zone rules for this host's
        // timezone can differ from its current one; per-instant is the only correct comparison.
        const hostOffsetMinutes = raw.getTimezoneOffset();
        if (hostOffsetMinutes !== 0) anyHostOffsetIsNonZero = true;

        if (naive !== corrected) {
          sawHostTimezoneDivergence = true;
          // Not a rounding artifact — the naive, app-visible value is off by exactly this host's
          // UTC offset at that instant. On a UTC host this branch never triggers at all.
          expect(naive - corrected, `row id=${r.id}, column "${column}"`).toBe(
            BigInt(hostOffsetMinutes) * 60_000_000n,
          );
        }
      }
    }
    expect(sawSubMillisecondDivergence).toBe(true);
    if (anyHostOffsetIsNonZero) expect(sawHostTimezoneDivergence).toBe(true);
  });

  it('FINDING: jsonb — a stored JSON null is indistinguishable from SQL NULL over a plain SQL read', async () => {
    // Row 51 stores an actual JSON `null` scalar (`JS.jsonNull`) in both jsonb columns.
    const jsonNullRow = ROWS.find((r) => r.c_json === JSON_NULL)!;
    const change = changesByRowId.get(jsonNullRow.id as number)!;
    expect(change.newRow!.c_json).toBe(JSON_NULL);
    expect(change.newRow!.c_json_n).toBe(JSON_NULL);

    const { rows } = await pool.query(`SELECT c_json, c_json_n FROM "${TABLE}" WHERE id = $1`, [
      jsonNullRow.id,
    ]);
    // node-postgres's default jsonb parser is `JSON.parse`, so a stored JSON `null` and a SQL
    // NULL column both surface as JS `null` here — the sentinel is unrecoverable once the value
    // has passed through the ordinary read path. Only the WAL path (which sees the wire's 'n'
    // vs 't' kind byte before any JSON parsing happens) keeps the two apart.
    expect(rows[0].c_json).toBeNull();
    expect(rows[0].c_json_n).toBeNull();
  });
});
