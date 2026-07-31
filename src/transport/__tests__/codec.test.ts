import { describe, expect, it } from 'vitest';
import { JSON_NULL } from '../../query/compare.js';
import type { ChangeEvent, ResyncEvent, WalEvent } from '../../wal/types.js';
import { decodeEvent, encodeEvent } from '../codec.js';

function changeEvent(overrides: Partial<ChangeEvent> = {}): WalEvent {
  const change: ChangeEvent = {
    kind: 'update',
    model: 'Widget',
    table: 'widgets',
    schema: 'public',
    lsn: '0/1A2B3C',
    commitLsn: '0/1A2B00',
    commitTime: 12345678901234n,
    newRow: {
      id: 9007199254740993n,
      label: 'a → b',
      settings: JSON_NULL,
      tags: [1n, 2n, 3n],
      createdAt: new Date('2026-03-04T05:06:07.891Z'),
    },
    oldRow: { id: 9007199254740993n, label: 'a', settings: null },
    unknownColumns: new Set(['secret']),
    ...overrides,
  };
  return { type: 'change', change };
}

describe('transport codec', () => {
  it('round-trips bigint, Date, and nested arrays exactly', () => {
    const event = changeEvent();
    const decoded = decodeEvent(encodeEvent(event)) as { type: 'change'; change: ChangeEvent };

    expect(decoded.change.commitTime).toBe(12345678901234n);
    expect(typeof decoded.change.newRow!.id).toBe('bigint');
    expect(decoded.change.newRow!.id).toBe(9007199254740993n);
    expect(decoded.change.newRow!.createdAt).toBeInstanceOf(Date);
    expect((decoded.change.newRow!.createdAt as Date).toISOString()).toBe(
      '2026-03-04T05:06:07.891Z',
    );
    expect(decoded.change.newRow!.tags).toEqual([1n, 2n, 3n]);
    expect(decoded.change.unknownColumns).toBeInstanceOf(Set);
    expect([...decoded.change.unknownColumns]).toEqual(['secret']);
  });

  it('keeps the JSON_NULL sentinel distinguishable from SQL NULL', () => {
    const event = changeEvent();
    const decoded = decodeEvent(encodeEvent(event)) as { type: 'change'; change: ChangeEvent };

    expect(decoded.change.newRow!.settings).toBe(JSON_NULL);
    expect(decoded.change.oldRow!.settings).toBeNull();
    expect(decoded.change.newRow!.settings).not.toBeNull();
  });

  it('round-trips a resync event', () => {
    const resync: ResyncEvent = {
      reason: 'truncate',
      detail: 'TRUNCATE affecting Widget.',
      tables: ['Widget'],
      lsn: '0/1A2B3C',
    };
    const event: WalEvent = { type: 'resync', resync };
    expect(decodeEvent(encodeEvent(event))).toEqual(event);
  });

  it('produces a plain JSON string, not the raw {json, meta} object', () => {
    const payload = encodeEvent(changeEvent());
    expect(typeof payload).toBe('string');
    expect(() => JSON.parse(payload)).not.toThrow();
  });
});
