import { describe, expect, it } from 'vitest';
import { isLiveSerializable } from '../rtk.js';

class Decimal {
  constructor(private readonly value: string) {}
  toFixed(): string {
    return this.value;
  }
}

describe('isLiveSerializable', () => {
  it('accepts the wire types rows carry', () => {
    expect(isLiveSerializable(1n)).toBe(true);
    expect(isLiveSerializable(new Date())).toBe(true);
    expect(isLiveSerializable(new Decimal('1.0000'))).toBe(true);
    expect(isLiveSerializable(new Uint8Array([1, 2]))).toBe(true);
  });

  it('accepts the plain values RTK already allows', () => {
    for (const value of ['a', 1, true, null, undefined, [], { id: 1n }]) {
      expect(isLiveSerializable(value)).toBe(true);
    }
    expect(isLiveSerializable(Object.create(null))).toBe(true);
  });

  it('still rejects functions and class instances', () => {
    expect(isLiveSerializable(() => {})).toBe(false);
    expect(isLiveSerializable(Symbol('s'))).toBe(false);
    expect(isLiveSerializable(new Map())).toBe(false);
    expect(isLiveSerializable(new (class Subscription {})())).toBe(false);
  });
});
