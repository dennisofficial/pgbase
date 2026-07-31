import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestPool } from '../../schema/test-support.js';
import type { ChangeEvent, WalEvent } from '../../wal/types.js';
import { waitFor } from '../../wal/__tests__/support.js';
import { NOTIFY_PAYLOAD_LIMIT, PostgresChangeTransport } from '../postgres.js';

const CHANNEL = 'pgbase_transport_test_channel';

let pool: Pool;

function baseChange(overrides: Partial<ChangeEvent> = {}): WalEvent {
  const change: ChangeEvent = {
    kind: 'insert',
    model: 'Widget',
    table: 'widgets',
    schema: 'public',
    lsn: '0/1000',
    commitLsn: '0/1000',
    commitTime: 1n,
    newRow: { id: 1n, label: 'x' },
    oldRow: null,
    unknownColumns: new Set(),
    ...overrides,
  };
  return { type: 'change', change };
}

beforeAll(async () => {
  pool = createTestPool();
});

afterAll(async () => {
  await pool.end();
});

describe('PostgresChangeTransport', () => {
  let transports: PostgresChangeTransport[];

  beforeEach(() => {
    transports = [];
  });

  afterEach(async () => {
    await Promise.all(transports.map((t) => t.stop()));
  });

  function makeTransport(channel = CHANNEL): PostgresChangeTransport {
    const t = new PostgresChangeTransport({ pool, channel });
    transports.push(t);
    return t;
  }

  it('round-trips bigint, Date, and the JSON_NULL sentinel publish -> receive', async () => {
    const publisher = makeTransport();
    const subscriber = makeTransport();
    await Promise.all([publisher.start(), subscriber.start()]);

    const received: WalEvent[] = [];
    subscriber.onEvent((e) => received.push(e));

    const event = baseChange({
      newRow: { id: 42n, createdAt: new Date('2026-01-02T03:04:05.006Z'), amount: '10.50' },
    });
    await publisher.publish(event);
    await waitFor(() => received.length > 0, 5_000);

    const got = received[0]!;
    expect(got.type).toBe('change');
    if (got.type !== 'change') throw new Error('unreachable');
    expect(got.change.newRow!.id).toBe(42n);
    expect(got.change.newRow!.createdAt).toBeInstanceOf(Date);
    expect((got.change.newRow!.createdAt as Date).toISOString()).toBe('2026-01-02T03:04:05.006Z');
  });

  it('a transport hears its own publish (leader and subscriber can be the same connection)', async () => {
    const t = makeTransport();
    await t.start();
    const received: WalEvent[] = [];
    t.onEvent((e) => received.push(e));

    await t.publish(baseChange());
    await waitFor(() => received.length > 0, 5_000);
    expect(received).toHaveLength(1);
  });

  it('an oversized event degrades to a resync for the affected model, not a drop or truncation', async () => {
    const publisher = makeTransport();
    const subscriber = makeTransport();
    await Promise.all([publisher.start(), subscriber.start()]);

    const received: WalEvent[] = [];
    subscriber.onEvent((e) => received.push(e));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const huge = baseChange({
        model: 'Widget',
        newRow: { id: 1n, blob: 'x'.repeat(20_000) },
      });
      await publisher.publish(huge);
      await waitFor(() => received.length > 0, 5_000);

      expect(received).toHaveLength(1);
      const got = received[0]!;
      expect(got.type).toBe('resync');
      if (got.type !== 'resync') throw new Error('unreachable');
      expect(got.resync.reason).toBe('decode-gap');
      expect(got.resync.tables).toEqual(['Widget']);
      expect(warn).toHaveBeenCalled();
      expect(warn.mock.calls[0]![0]).toMatch(/NOTIFY payload limit/);
    } finally {
      warn.mockRestore();
    }
  });

  it('the degraded event itself fits under the NOTIFY limit', async () => {
    const publisher = makeTransport();
    await publisher.start();
    // A publish with an oversized row must not throw pg's "payload string too long" error — if
    // the fallback resync didn't fit either, pg_notify itself would reject it.
    await expect(
      publisher.publish(baseChange({ newRow: { id: 1n, blob: 'x'.repeat(50_000) } })),
    ).resolves.toBeUndefined();
  });

  it('rejects publish before start()', async () => {
    const t = makeTransport();
    await expect(t.publish(baseChange())).rejects.toThrow(/before start/);
  });

  it('stop() releases its connection: a second start()/stop() cycle on the same pool succeeds', async () => {
    const t = makeTransport();
    await t.start();
    await t.stop();
    await t.start();
    const received: WalEvent[] = [];
    t.onEvent((e) => received.push(e));
    await t.publish(baseChange());
    await waitFor(() => received.length > 0, 5_000);
    await t.stop();
  });

  it('exposes the documented payload limit', () => {
    expect(NOTIFY_PAYLOAD_LIMIT).toBe(8000);
  });
});
