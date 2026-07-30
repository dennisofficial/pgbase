import type { ResolvedField, ResolvedModel } from '../schema/types.js';
import { FALSE, TRUE, type LiveWhere, type OneOrMany, type PredicateNode } from './ast.js';
import { OID, coerceValue } from './compare.js';
import { QueryError } from './errors.js';

type FieldCategory = 'list' | 'string' | 'bool' | 'scalar' | 'json';

function categorize(field: ResolvedField): FieldCategory {
  if (field.elementTypeOid !== null) return 'list';
  switch (field.typeOid) {
    case OID.BOOL:
      return 'bool';
    case OID.TEXT:
    case OID.VARCHAR:
    case OID.BPCHAR:
      return 'string';
    case OID.JSON:
    case OID.JSONB:
      return 'json';
    default:
      return 'scalar';
  }
}

const ALLOWED_OPERATORS: Record<FieldCategory, ReadonlySet<string>> = {
  list: new Set(['equals', 'has', 'hasEvery', 'hasSome', 'isEmpty']),
  string: new Set([
    'equals',
    'not',
    'in',
    'notIn',
    'lt',
    'lte',
    'gt',
    'gte',
    'contains',
    'startsWith',
    'endsWith',
  ]),
  bool: new Set(['equals', 'not']),
  scalar: new Set(['equals', 'not', 'in', 'notIn', 'lt', 'lte', 'gt', 'gte']),
  json: new Set(['equals', 'not']),
};

function isFilterObject(raw: unknown, category: FieldCategory): raw is Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || raw instanceof Date)
    return false;
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) return false;
  if (category !== 'json') return true;
  const keys = Object.keys(raw as Record<string, unknown>);
  return keys.length > 0 && keys.every((k) => k === 'equals' || k === 'not');
}

function toArray<T>(v: OneOrMany<T>): readonly T[] {
  return Array.isArray(v) ? v : [v as T];
}

function combine(kind: 'and' | 'or', nodes: readonly PredicateNode[]): PredicateNode {
  if (nodes.length === 0) return kind === 'and' ? TRUE : FALSE;
  if (nodes.length === 1) return nodes[0]!;
  return { kind, children: nodes };
}

export function normalize(
  where: LiveWhere,
  model: ResolvedModel,
  allowedFields: ReadonlySet<string>,
): PredicateNode {
  const byName = new Map(model.fields.map((f) => [f.name, f] as const));
  return normalizeWhere(where, byName, allowedFields);
}

function normalizeWhere(
  where: LiveWhere,
  byName: ReadonlyMap<string, ResolvedField>,
  allowedFields: ReadonlySet<string>,
): PredicateNode {
  if (typeof where !== 'object' || where === null || Array.isArray(where)) {
    throw new QueryError('A "where" clause must be an object.');
  }

  const parts: PredicateNode[] = [];
  for (const key of Object.keys(where)) {
    const value = (where as Record<string, unknown>)[key];
    if (key === 'AND') {
      const children = toArray(value as OneOrMany<LiveWhere>).map((w) =>
        normalizeWhere(w, byName, allowedFields),
      );
      parts.push(combine('and', children));
    } else if (key === 'OR') {
      if (!Array.isArray(value)) throw new QueryError('"OR" must be an array of "where" clauses.');
      parts.push(
        value.length === 0
          ? FALSE
          : { kind: 'or', children: value.map((w) => normalizeWhere(w, byName, allowedFields)) },
      );
    } else if (key === 'NOT') {
      // Prisma: `NOT: [a, b]` means every element is individually false, i.e. `NOT a AND NOT b`
      // — an AND of independent negations, not a negation of a conjunction. A bare (non-array)
      // NOT is the one-element case of the same rule.
      const negations = toArray(value as OneOrMany<LiveWhere>).map((w): PredicateNode => ({
        kind: 'not',
        child: normalizeWhere(w, byName, allowedFields),
      }));
      parts.push(combine('and', negations));
    } else {
      const field = byName.get(key);
      if (!field || !allowedFields.has(key)) {
        throw new QueryError(`Unknown or disallowed filter field "${key}".`);
      }
      if (field.isCitext) {
        throw new QueryError(
          `Field "${key}" is citext and cannot be filtered: Postgres compares citext ` +
            `case-insensitively and the in-memory evaluator does not, so the two interpreters ` +
            `could never agree.`,
        );
      }
      parts.push(normalizeFieldValue(field, value));
    }
  }
  return combine('and', parts);
}

function normalizeFieldValue(field: ResolvedField, rawValue: unknown): PredicateNode {
  const category = categorize(field);
  if (rawValue === null) return { kind: 'isNull', field, negated: false };
  if (isFilterObject(rawValue, category)) {
    return normalizeFilterObject(field, rawValue, category);
  }
  if (category === 'list' && !Array.isArray(rawValue)) {
    throw new QueryError(`Field "${field.name}": expected an array, or a list filter object.`);
  }
  return buildCompare(field, 'equals', rawValue, false);
}

function normalizeFilterObject(
  field: ResolvedField,
  obj: Record<string, unknown>,
  category: FieldCategory,
): PredicateNode {
  const allowed = ALLOWED_OPERATORS[category];
  const keys = Object.keys(obj);
  for (const key of keys) {
    if (key !== 'mode' && !allowed.has(key)) {
      throw new QueryError(
        `Field "${field.name}": operator "${key}" is not valid for this column.`,
      );
    }
  }

  const mode = obj['mode'];
  if (mode !== undefined) {
    if (category !== 'string') {
      throw new QueryError(`Field "${field.name}": "mode" is only valid on text columns.`);
    }
    if (mode !== 'default' && mode !== 'insensitive') {
      throw new QueryError(`Field "${field.name}": "mode" must be "default" or "insensitive".`);
    }
  }
  const insensitive = mode === 'insensitive';
  if (insensitive) {
    const notIsNested = 'not' in obj && isFilterObject(obj['not'], category);
    const hasTextOp =
      'equals' in obj ||
      'contains' in obj ||
      'startsWith' in obj ||
      'endsWith' in obj ||
      ('not' in obj && !notIsNested && obj['not'] !== null);
    if (!hasTextOp) {
      throw new QueryError(
        `Field "${field.name}": "mode: insensitive" requires equals/not/contains/startsWith/endsWith at the same level.`,
      );
    }
  }

  const nodes: PredicateNode[] = [];
  for (const key of keys) {
    if (key === 'mode') continue;
    const value = obj[key];
    switch (key) {
      case 'equals':
        nodes.push(
          value === null
            ? { kind: 'isNull', field, negated: false }
            : buildCompare(field, 'equals', value, insensitive),
        );
        break;
      case 'not':
        nodes.push(buildNot(field, value, category, insensitive));
        break;
      case 'in':
        nodes.push(buildSet(field, 'in', value));
        break;
      case 'notIn':
        nodes.push(buildSet(field, 'notIn', value));
        break;
      case 'lt':
      case 'lte':
      case 'gt':
      case 'gte':
        nodes.push(buildCompare(field, key, value, false));
        break;
      case 'contains':
      case 'startsWith':
      case 'endsWith':
        if (typeof value !== 'string') {
          throw new QueryError(`Field "${field.name}": "${key}" requires a string value.`);
        }
        nodes.push(buildCompare(field, key, value, insensitive));
        break;
      case 'has':
        nodes.push(value === null ? FALSE : buildList(field, 'has', [value]));
        break;
      case 'hasSome':
        nodes.push(buildList(field, 'hasSome', requireArray(field, 'hasSome', value)));
        break;
      case 'hasEvery':
        nodes.push(buildList(field, 'hasEvery', requireArray(field, 'hasEvery', value)));
        break;
      case 'isEmpty': {
        if (typeof value !== 'boolean') {
          throw new QueryError(`Field "${field.name}": "isEmpty" requires a boolean.`);
        }
        const emptyNode: PredicateNode = { kind: 'list', field, op: 'isEmpty', values: [] };
        nodes.push(value ? emptyNode : { kind: 'not', child: emptyNode });
        break;
      }
    }
  }
  return combine('and', nodes);
}

function buildNot(
  field: ResolvedField,
  rawValue: unknown,
  category: FieldCategory,
  insensitive: boolean,
): PredicateNode {
  if (rawValue === null) return { kind: 'isNull', field, negated: true };
  if (isFilterObject(rawValue, category)) {
    return { kind: 'not', child: normalizeFilterObject(field, rawValue, category) };
  }
  if (category === 'list') {
    throw new QueryError(`Field "${field.name}": "not" is not supported on array columns.`);
  }
  return buildCompare(field, 'not', rawValue, insensitive);
}

function buildCompare(
  field: ResolvedField,
  op: 'equals' | 'not' | 'lt' | 'lte' | 'gt' | 'gte' | 'contains' | 'startsWith' | 'endsWith',
  rawValue: unknown,
  insensitive: boolean,
): PredicateNode {
  if (rawValue === null) {
    throw new QueryError(`Field "${field.name}": operator "${op}" does not accept null here.`);
  }
  const value = coerceValue(
    field.typeOid,
    field.elementTypeOid,
    rawValue,
    field.name,
    field.enumValues,
  );
  return { kind: 'compare', field, op, value, insensitive };
}

function buildSet(field: ResolvedField, op: 'in' | 'notIn', rawValues: unknown): PredicateNode {
  const arr = requireArray(field, op, rawValues);
  if (arr.length === 0) return op === 'in' ? FALSE : TRUE;
  const values = arr.map((v) => {
    if (v === null)
      throw new QueryError(`Field "${field.name}": "${op}" values cannot include null.`);
    return coerceValue(field.typeOid, null, v, field.name, field.enumValues);
  });
  return { kind: 'set', field, op, values };
}

function buildList(
  field: ResolvedField,
  op: 'has' | 'hasSome' | 'hasEvery',
  rawValues: readonly unknown[],
): PredicateNode {
  if (field.elementTypeOid === null) {
    throw new QueryError(`Field "${field.name}": "${op}" is only valid on array columns.`);
  }
  const values = rawValues.map((v) => {
    if (v === null)
      throw new QueryError(`Field "${field.name}": "${op}" values cannot include null.`);
    return coerceValue(field.elementTypeOid as number, null, v, field.name, field.enumValues);
  });
  return { kind: 'list', field, op, values };
}

function requireArray(field: ResolvedField, op: string, value: unknown): readonly unknown[] {
  if (!Array.isArray(value))
    throw new QueryError(`Field "${field.name}": "${op}" requires an array.`);
  return value;
}
