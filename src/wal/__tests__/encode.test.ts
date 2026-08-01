import { describe, expect, it } from 'vitest';
import { JSON_NULL, OID } from '../../query/compare.js';
import type { ResolvedField } from '../../schema/types.js';
import { decodeColumn } from '../decode.js';
import { encodeColumn } from '../encode.js';

function field(over: Partial<ResolvedField> & { typeOid: number }): ResolvedField {
  return {
    name: 'f',
    column: 'f',
    type: 'String',
    nativeType: null,
    enumName: null,
    isList: false,
    isRequired: true,
    isId: false,
    isUnique: false,
    isUpdatedAt: false,
    isForeignKey: false,
    typeName: 'text',
    elementTypeOid: null,
    elementTypeName: null,
    isCitext: false,
    enumValues: null,
    ...over,
  };
}

class FakeDecimal {
  constructor(private readonly raw: string) {}
  toFixed(): string {
    return this.raw;
  }
}

describe('encodeColumn', () => {
  it('puts a WAL timestamp back on the Date the read path returns', () => {
    const tstz = field({ typeOid: OID.TIMESTAMPTZ });
    const wire = '2024-03-01 12:34:56.789+00';
    expect(encodeColumn(tstz, decodeColumn(tstz, wire))).toEqual(
      new Date('2024-03-01T12:34:56.789Z'),
    );
  });

  it('encodes timestamps from before the epoch without drifting a millisecond', () => {
    const ts = field({ typeOid: OID.TIMESTAMP });
    const wire = '1969-07-20 20:17:40.123';
    expect(encodeColumn(ts, decodeColumn(ts, wire))).toEqual(new Date('1969-07-20T20:17:40.123Z'));
  });

  it('encodes a date as UTC midnight', () => {
    const date = field({ typeOid: OID.DATE });
    expect(encodeColumn(date, decodeColumn(date, '2024-03-01'))).toEqual(
      new Date('2024-03-01T00:00:00.000Z'),
    );
  });

  it('builds a Decimal for numerics only when a constructor was configured', () => {
    const numeric = field({ typeOid: OID.NUMERIC });
    const raw = decodeColumn(numeric, '12345678901234.5678');
    expect(encodeColumn(numeric, raw)).toBe('12345678901234.5678');
    const decimal = encodeColumn(numeric, raw, {
      decimalConstructor: (v) => new FakeDecimal(v),
    }) as FakeDecimal;
    expect(decimal).toBeInstanceOf(FakeDecimal);
    expect(decimal.toFixed()).toBe('12345678901234.5678');
  });

  it('turns the stored-JSON-null sentinel back into null', () => {
    const json = field({ typeOid: OID.JSONB });
    expect(decodeColumn(json, 'null')).toBe(JSON_NULL);
    expect(encodeColumn(json, JSON_NULL)).toBeNull();
    expect(encodeColumn(json, { a: [1, 2] })).toEqual({ a: [1, 2] });
  });

  it('leaves the types the read path already agrees on alone', () => {
    expect(encodeColumn(field({ typeOid: OID.INT8 }), 9007199254740993n)).toBe(9007199254740993n);
    expect(encodeColumn(field({ typeOid: OID.INT4 }), 7)).toBe(7);
    expect(encodeColumn(field({ typeOid: OID.UUID }), 'a-uuid')).toBe('a-uuid');
    expect(encodeColumn(field({ typeOid: OID.BOOL }), true)).toBe(true);
    expect(encodeColumn(field({ typeOid: OID.TEXT, isCitext: true }), 'Mixed')).toBe('Mixed');
    expect(encodeColumn(field({ typeOid: 0, enumValues: ['QUEUED', 'DONE'] }), 'QUEUED')).toBe(
      'QUEUED',
    );
  });

  it('walks arrays element by element and passes nulls through', () => {
    const stamps = field({ typeOid: 1185, elementTypeOid: OID.TIMESTAMPTZ, isList: true });
    expect(encodeColumn(stamps, [1709296496789000n, null])).toEqual([
      new Date('2024-03-01T12:34:56.789Z'),
      null,
    ]);
    expect(encodeColumn(field({ typeOid: OID.TIMESTAMPTZ }), null)).toBeNull();
  });
});
