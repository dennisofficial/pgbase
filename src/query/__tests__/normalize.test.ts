import { describe, expect, it } from 'vitest';
import type { ResolvedField, ResolvedModel } from '../../schema/types.js';
import { OID } from '../compare.js';
import { normalize } from '../normalize.js';

function field(name: string, overrides: Partial<ResolvedField> = {}): ResolvedField {
  return {
    name,
    column: name,
    type: 'Unknown',
    nativeType: null,
    enumName: null,
    isList: false,
    isRequired: true,
    isId: false,
    isUnique: false,
    isUpdatedAt: false,
    isForeignKey: false,
    typeOid: OID.TEXT,
    typeName: 'text',
    elementTypeOid: null,
    isCitext: false,
    ...overrides,
  };
}

const fields = [
  field('name', { typeOid: OID.TEXT }),
  field('nick', { typeOid: OID.TEXT, isCitext: true }),
  field('age', { typeOid: OID.INT4 }),
  field('active', { typeOid: OID.BOOL }),
  field('tags', { typeOid: OID.TEXT, elementTypeOid: OID.TEXT, isList: true }),
  field('meta', { typeOid: OID.JSONB }),
];

const model = {
  fields,
  byColumn: new Map(fields.map((f) => [f.column, f])),
} as unknown as ResolvedModel;

const allowed = new Set(fields.map((f) => f.name));

describe('normalize', () => {
  it('shorthand value is equals', () => {
    expect(normalize({ name: 'x' }, model, allowed)).toEqual({
      kind: 'compare',
      field: field('name'),
      op: 'equals',
      value: 'x',
      insensitive: false,
    });
  });

  it('equals: null and not: null become isNull nodes', () => {
    expect(normalize({ name: { equals: null } }, model, allowed)).toEqual({
      kind: 'isNull',
      field: field('name'),
      negated: false,
    });
    expect(normalize({ name: { not: null } }, model, allowed)).toEqual({
      kind: 'isNull',
      field: field('name'),
      negated: true,
    });
    expect(normalize({ name: null }, model, allowed)).toEqual({
      kind: 'isNull',
      field: field('name'),
      negated: false,
    });
  });

  it('empty AND is TRUE, empty OR is FALSE', () => {
    expect(normalize({ AND: [] }, model, allowed)).toEqual({ kind: 'literal', value: true });
    expect(normalize({ OR: [] }, model, allowed)).toEqual({ kind: 'literal', value: false });
  });

  it('NOT array form is AND of individual negations', () => {
    const node = normalize({ NOT: [{ name: 'a' }, { name: 'b' }] }, model, allowed);
    expect(node).toEqual({
      kind: 'and',
      children: [
        { kind: 'not', child: { kind: 'compare', field: field('name'), op: 'equals', value: 'a', insensitive: false } },
        { kind: 'not', child: { kind: 'compare', field: field('name'), op: 'equals', value: 'b', insensitive: false } },
      ],
    });
  });

  it('bare NOT is the one-element case of the array rule', () => {
    const single = normalize({ NOT: { name: 'a' } }, model, allowed);
    const arrayForm = normalize({ NOT: [{ name: 'a' }] }, model, allowed);
    expect(single).toEqual(arrayForm);
  });

  it('rejects an unknown field, naming it', () => {
    expect(() => normalize({ nope: 'x' }, model, allowed)).toThrow(/"nope"/);
  });

  it('rejects a field not in the allowlist even if it exists on the model', () => {
    expect(() => normalize({ name: 'x' }, model, new Set(['age']))).toThrow(/"name"/);
  });

  it('rejects citext columns outright', () => {
    expect(() => normalize({ nick: 'x' }, model, allowed)).toThrow(/citext/i);
  });

  it('rejects an operator not valid for the column category', () => {
    expect(() => normalize({ active: { contains: 'x' } }, model, allowed)).toThrow(/"contains"/);
    expect(() => normalize({ age: { contains: '1' } }, model, allowed)).toThrow(/"contains"/);
  });

  it('rejects mode:insensitive on a non-text column', () => {
    expect(() => normalize({ age: { equals: 1, mode: 'insensitive' } as never }, model, allowed)).toThrow(/mode/i);
  });

  it('rejects mode:insensitive with no compatible op at the same level', () => {
    expect(() => normalize({ name: { in: ['a'], mode: 'insensitive' } }, model, allowed)).toThrow(/mode/i);
  });

  it('accepts mode:insensitive alongside contains', () => {
    const node = normalize({ name: { contains: 'x', mode: 'insensitive' } }, model, allowed);
    expect(node).toEqual({ kind: 'compare', field: field('name'), op: 'contains', value: 'x', insensitive: true });
  });

  it('in: [] is FALSE, notIn: [] is TRUE', () => {
    expect(normalize({ age: { in: [] } }, model, allowed)).toEqual({ kind: 'literal', value: false });
    expect(normalize({ age: { notIn: [] } }, model, allowed)).toEqual({ kind: 'literal', value: true });
  });

  it('list fields reject "not"', () => {
    expect(() => normalize({ tags: { not: ['a'] } as never }, model, allowed)).toThrow(/"not"/);
  });

  it('isEmpty: false is NOT(isEmpty)', () => {
    expect(normalize({ tags: { isEmpty: false } }, model, allowed)).toEqual({
      kind: 'not',
      child: { kind: 'list', field: field('tags', { typeOid: OID.TEXT, elementTypeOid: OID.TEXT, isList: true }), op: 'isEmpty', values: [] },
    });
  });

  it('nested not-filter-object wraps a real "not" node', () => {
    const node = normalize({ name: { not: { contains: 'x' } } }, model, allowed);
    expect(node).toEqual({
      kind: 'not',
      child: { kind: 'compare', field: field('name'), op: 'contains', value: 'x', insensitive: false },
    });
  });

  it('multiple keys on one field combine as AND', () => {
    const node = normalize({ age: { gt: 1, lt: 10 } }, model, allowed);
    expect(node).toEqual({
      kind: 'and',
      children: [
        { kind: 'compare', field: field('age', { typeOid: OID.INT4 }), op: 'gt', value: 1, insensitive: false },
        { kind: 'compare', field: field('age', { typeOid: OID.INT4 }), op: 'lt', value: 10, insensitive: false },
      ],
    });
  });

  it('a value that cannot be coerced throws at normalize time', () => {
    expect(() => normalize({ age: { equals: 'not-a-number' } as never }, model, allowed)).toThrow();
  });
});
