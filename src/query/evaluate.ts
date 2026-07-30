import type { PredicateNode, Truth } from './ast.js';
import { asciiLower, getComparator } from './compare.js';

type Row = Record<string, unknown>;

export function evaluate(node: PredicateNode, row: Row): boolean {
  return evalNode(node, row) === true;
}

function getRaw(row: Row, column: string): unknown {
  if (!(column in row)) throw new Error(`evaluate(): row is missing column "${column}".`);
  return row[column];
}

function evalNode(node: PredicateNode, row: Row): Truth {
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'and':
      return evalAnd(node.children, row);
    case 'or':
      return evalOr(node.children, row);
    case 'not': {
      const t = evalNode(node.child, row);
      return t === null ? null : !t;
    }
    case 'isNull': {
      const isNull = getRaw(row, node.field.column) === null;
      return node.negated ? !isNull : isNull;
    }
    case 'compare':
      return evalCompare(node, row);
    case 'set':
      return evalSet(node, row);
    case 'list':
      return evalList(node, row);
  }
}

function evalAnd(children: readonly PredicateNode[], row: Row): Truth {
  let unknown = false;
  for (const c of children) {
    const t = evalNode(c, row);
    if (t === false) return false;
    if (t === null) unknown = true;
  }
  return unknown ? null : true;
}

function evalOr(children: readonly PredicateNode[], row: Row): Truth {
  let unknown = false;
  for (const c of children) {
    const t = evalNode(c, row);
    if (t === true) return true;
    if (t === null) unknown = true;
  }
  return unknown ? null : false;
}

function evalTextOp(
  op: 'contains' | 'startsWith' | 'endsWith',
  raw: string,
  needle: string,
  insensitive: boolean,
): boolean {
  const a = insensitive ? asciiLower(raw) : raw;
  const b = insensitive ? asciiLower(needle) : needle;
  switch (op) {
    case 'contains':
      return a.includes(b);
    case 'startsWith':
      return a.startsWith(b);
    case 'endsWith':
      return a.endsWith(b);
  }
}

function evalCompare(node: Extract<PredicateNode, { kind: 'compare' }>, row: Row): Truth {
  const raw = getRaw(row, node.field.column);
  if (raw === null) return null;
  const { field, op, value, insensitive } = node;

  if (op === 'contains' || op === 'startsWith' || op === 'endsWith') {
    return evalTextOp(op, raw as string, value as string, insensitive);
  }

  const comparator = getComparator(field.typeOid, field.elementTypeOid);
  if (op === 'equals' || op === 'not') {
    const eq = insensitive
      ? asciiLower(raw as string) === asciiLower(value as string)
      : comparator.equals(raw, value);
    return op === 'equals' ? eq : !eq;
  }

  const cmp = comparator.compare(raw, value);
  switch (op) {
    case 'lt':
      return cmp < 0;
    case 'lte':
      return cmp <= 0;
    case 'gt':
      return cmp > 0;
    case 'gte':
      return cmp >= 0;
  }
}

function evalSet(node: Extract<PredicateNode, { kind: 'set' }>, row: Row): Truth {
  // `x = ANY('{}')` is unconditionally false in Postgres, even for `x IS NULL` — the empty-array
  // case bypasses the usual "NULL compares to unknown" rule entirely, on both sides.
  if (node.values.length === 0) return node.op === 'in' ? false : true;
  const raw = getRaw(row, node.field.column);
  if (raw === null) return null;
  const comparator = getComparator(node.field.typeOid, node.field.elementTypeOid);
  const found = node.values.some((v) => comparator.equals(raw, v));
  return node.op === 'in' ? found : !found;
}

function evalList(node: Extract<PredicateNode, { kind: 'list' }>, row: Row): Truth {
  const raw = getRaw(row, node.field.column);
  if (raw === null) return null;
  if (!Array.isArray(raw))
    throw new Error(`evaluate(): column "${node.field.column}" is not an array.`);
  if (node.op === 'isEmpty') return raw.length === 0;

  const elementComparator = getComparator(node.field.elementTypeOid as number, null);
  const matches = (needle: unknown) =>
    raw.some((el) => el !== null && elementComparator.equals(el, needle));
  switch (node.op) {
    case 'has':
      // `= ANY(col)` propagates NULL: a stored NULL element means "might have matched", so a
      // non-match is unknown rather than false. `&&` and `@>` below do NOT propagate — verified
      // against Postgres, they return false in the same situation.
      if (matches(node.values[0])) return true;
      return raw.some((el) => el === null) ? null : false;
    case 'hasSome':
      return node.values.some(matches);
    case 'hasEvery':
      return node.values.every(matches);
  }
}
