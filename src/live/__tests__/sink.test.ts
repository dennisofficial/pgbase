import { describe, expect, it } from 'vitest';
import type { ChangeEvent, WalEvent } from '../../wal/types.js';
import { InMemoryChangeSink } from '../sink.js';

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function insertOf(id: number): WalEvent {
  const change: ChangeEvent = {
    kind: 'insert',
    model: 'Widget',
    table: 'widgets',
    schema: 'public',
    lsn: `0/${id}`,
    commitLsn: `0/${id}`,
    commitTime: 0n,
    newRow: { id },
    oldRow: null,
    unknownColumns: new Set(),
  };
  return { type: 'change', change };
}

describe('InMemoryChangeSink', () => {
  it('push returns synchronously and delivers events on a later tick', async () => {
    const sink = new InMemoryChangeSink({ maxQueued: 100, onOverflow: 'resync' });
    const received: WalEvent[] = [];
    sink.onEvent((e) => received.push(e));

    const before = Date.now();
    sink.push(insertOf(1));
    expect(Date.now() - before).toBeLessThan(5);
    expect(received).toEqual([]); // not delivered yet — push never calls the consumer inline

    await tick();
    expect(received).toEqual([insertOf(1)]);
  });

  it('overflow drops the backlog and emits exactly one decode-gap resync', async () => {
    const sink = new InMemoryChangeSink({ maxQueued: 3, onOverflow: 'resync' });
    const received: WalEvent[] = [];
    sink.onEvent((e) => received.push(e));

    for (let i = 1; i <= 10; i++) sink.push(insertOf(i));
    await tick();

    const resyncs = received.filter((e) => e.type === 'resync');
    expect(resyncs).toHaveLength(1);
    expect(resyncs[0]).toMatchObject({ resync: { reason: 'decode-gap' } });
    // The pre-overflow backlog is gone; at most the tail after the reset survives alongside it.
    expect(received.length).toBeLessThan(10);
  });

  it('does not overflow when drained faster than it fills', async () => {
    const sink = new InMemoryChangeSink({ maxQueued: 2, onOverflow: 'resync' });
    const received: WalEvent[] = [];
    sink.onEvent((e) => received.push(e));

    for (let i = 1; i <= 5; i++) {
      sink.push(insertOf(i));
      await tick();
    }
    expect(received.filter((e) => e.type === 'resync')).toHaveLength(0);
    expect(received).toHaveLength(5);
  });
});
