import { describe, expect, it } from 'vitest';
import { keyOf } from '../protocol.js';

/** Stand-in for Prisma's Decimal: an exact decimal string behind a class. */
class FakeDecimal {
  constructor(private readonly digits: string) {}
  toFixed(): string {
    return this.digits;
  }
}

describe('keyOf', () => {
  it('keys a BigInt primary key without throwing', () => {
    // `id BigInt @id @default(autoincrement())` — an int8 autoincrement, one of the most ordinary
    // primary keys there is. superjson decodes it to a real bigint, and JSON.stringify throws on
    // one, which took out both the server's snapshot map and the client's cache.
    expect(() => keyOf(['id'], { id: 9007199254740993n })).not.toThrow();
    expect(keyOf(['id'], { id: 1n })).not.toEqual(keyOf(['id'], { id: 2n }));
  });

  it('does not merge values that only look alike', () => {
    // One key space for every type. Collapsing these would silently unify distinct rows.
    const keys = [
      keyOf(['id'], { id: 1 }),
      keyOf(['id'], { id: '1' }),
      keyOf(['id'], { id: 1n }),
      keyOf(['id'], { id: true }),
      keyOf(['id'], { id: null }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('distinguishes Decimals that a JSON round trip would flatten', () => {
    expect(keyOf(['amount'], { amount: new FakeDecimal('1.50') })).not.toEqual(
      keyOf(['amount'], { amount: new FakeDecimal('1.51') }),
    );
    expect(keyOf(['amount'], { amount: new FakeDecimal('1.50') })).toEqual(
      keyOf(['amount'], { amount: new FakeDecimal('1.50') }),
    );
  });

  it('keys a bytea primary key by its bytes', () => {
    expect(keyOf(['id'], { id: new Uint8Array([1, 2, 3]) })).toEqual(
      keyOf(['id'], { id: new Uint8Array([1, 2, 3]) }),
    );
    expect(keyOf(['id'], { id: new Uint8Array([1, 2, 3]) })).not.toEqual(
      keyOf(['id'], { id: new Uint8Array([1, 2, 4]) }),
    );
  });

  it('keys equal Dates identically', () => {
    expect(keyOf(['at'], { at: new Date('2026-01-01T00:00:00Z') })).toEqual(
      keyOf(['at'], { at: new Date('2026-01-01T00:00:00Z') }),
    );
  });

  it('cannot have a composite key forged by embedding the separator', () => {
    // Two-part keys must not collide with a one-part key that contains the separator text.
    expect(keyOf(['a', 'b'], { a: 'x', b: 'y' })).not.toEqual(
      keyOf(['a', 'b'], { a: 'x y', b: '' }),
    );
  });

  it('is stable across calls for the same row', () => {
    const row = { orgId: 'org-1', seq: 42n };
    expect(keyOf(['orgId', 'seq'], row)).toEqual(keyOf(['orgId', 'seq'], row));
  });
});
