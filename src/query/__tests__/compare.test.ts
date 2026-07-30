import { describe, expect, it } from 'vitest';
import { getComparator } from '../compare.js';

// Mirrors job_status: declaration order disagrees with text order on this exact pair.
// 'RUNNING' < 'FAILED' by declaration index, but 'RUNNING' > 'FAILED' lexically.
const JOB_STATUS = ['QUEUED', 'RUNNING', 'DONE', 'FAILED'] as const;

describe('enum comparator', () => {
  it('orders by declaration index, not text — disagrees with lexical order on RUNNING/FAILED', () => {
    const enumCmp = getComparator(99999, null, JOB_STATUS);
    expect(enumCmp.compare('RUNNING', 'FAILED')).toBeLessThan(0);

    const textCmp = getComparator(25, null, null); // OID.TEXT
    expect(textCmp.compare('RUNNING', 'FAILED')).toBeGreaterThan(0);
  });

  it('equality agrees with text regardless of declaration order', () => {
    const enumCmp = getComparator(99999, null, JOB_STATUS);
    expect(enumCmp.equals('RUNNING', 'RUNNING')).toBe(true);
    expect(enumCmp.equals('RUNNING', 'FAILED')).toBe(false);
  });

  it('a value outside the declared members throws rather than sorting as -1', () => {
    const enumCmp = getComparator(99999, null, JOB_STATUS);
    expect(() => enumCmp.compare('NOPE', 'QUEUED')).toThrow(/not a member/);
    expect(() => enumCmp.compare('QUEUED', 'NOPE')).toThrow(/not a member/);
  });

  it('array-of-enum element comparator also orders by declaration index', () => {
    const arrayCmp = getComparator(99998, 99999, JOB_STATUS);
    expect(arrayCmp.compare(['RUNNING'], ['FAILED'])).toBeLessThan(0);
    expect(arrayCmp.equals(['QUEUED', 'RUNNING'], ['QUEUED', 'RUNNING'])).toBe(true);
  });
});
