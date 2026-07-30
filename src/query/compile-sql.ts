import type { ResolvedField } from '../schema/types.js';
import type { PredicateNode } from './ast.js';
import { OID, formatArrayLiteral, formatParamText, isTextOid, sqlTypeName } from './compare.js';
import { QueryError } from './errors.js';

export interface CompiledSql {
  readonly text: string;
  readonly values: readonly string[];
}

export function compileSql(node: PredicateNode): CompiledSql {
  const values: string[] = [];
  const text = compileNode(node, values);
  return { text, values };
}

function push(values: string[], text: string): string {
  values.push(text);
  return `$${values.length}`;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function col(field: ResolvedField): string {
  return quoteIdent(field.column);
}

function compileNode(node: PredicateNode, values: string[]): string {
  switch (node.kind) {
    case 'literal':
      return node.value ? 'TRUE' : 'FALSE';
    case 'and':
      return node.children.length === 0
        ? 'TRUE'
        : `(${node.children.map((c) => compileNode(c, values)).join(' AND ')})`;
    case 'or':
      return node.children.length === 0
        ? 'FALSE'
        : `(${node.children.map((c) => compileNode(c, values)).join(' OR ')})`;
    case 'not':
      return `(NOT ${compileNode(node.child, values)})`;
    case 'isNull':
      return `${col(node.field)} IS ${node.negated ? 'NOT ' : ''}NULL`;
    case 'compare':
      return compileCompare(node, values);
    case 'set':
      return compileSet(node, values);
    case 'list':
      return compileList(node, values);
  }
}

function likePattern(op: 'contains' | 'startsWith' | 'endsWith', raw: string): string {
  const escaped = raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  switch (op) {
    case 'contains':
      return `%${escaped}%`;
    case 'startsWith':
      return `${escaped}%`;
    case 'endsWith':
      return `%${escaped}`;
  }
}

function compileCompare(
  node: Extract<PredicateNode, { kind: 'compare' }>,
  values: string[],
): string {
  const { field, op, value, insensitive } = node;
  const isEnum = field.enumName !== null;

  if (field.elementTypeOid !== null) {
    // The only compare op normalize() ever emits for an array field is whole-array equals/not.
    const elemSqlType = isEnum
      ? quoteIdent(field.elementTypeName!)
      : sqlTypeName(field.elementTypeOid);
    const literal = formatArrayLiteral(field.elementTypeOid, value as readonly unknown[], isEnum);
    const p = push(values, literal);
    const right = `${p}::${elemSqlType}[]`;
    return op === 'equals' ? `${col(field)} = ${right}` : `${col(field)} <> ${right}`;
  }

  const oid = field.typeOid;
  const isText = isTextOid(oid);
  const isJson = oid === OID.JSON || oid === OID.JSONB;

  if (op === 'contains' || op === 'startsWith' || op === 'endsWith') {
    if (!isText) throw new QueryError(`compileSql: "${op}" is only valid for text columns.`);
    const p = push(values, likePattern(op, value as string));
    const left = insensitive ? `lower(${col(field)} COLLATE "C")` : `${col(field)} COLLATE "C"`;
    const right = insensitive ? `lower(${p}::text COLLATE "C")` : `${p}::text COLLATE "C"`;
    return `${left} LIKE ${right} ESCAPE '\\'`;
  }

  // Enum columns get neither `COLLATE "C"` (Postgres rejects a collation on a non-collatable
  // type) nor a builtin `sqlTypeName` — the cast target is the enum's own per-install type name.
  const sqlType = isEnum ? quoteIdent(field.typeName) : isJson ? 'jsonb' : sqlTypeName(oid);
  const columnExpr = isJson ? `${col(field)}::jsonb` : col(field);

  if (op === 'equals' || op === 'not') {
    const p = push(values, formatParamText(oid, value, isEnum));
    let left = columnExpr;
    let right = `${p}::${sqlType}`;
    if (isText) {
      left = insensitive ? `lower(${left} COLLATE "C")` : `${left} COLLATE "C"`;
      right = insensitive ? `lower(${right} COLLATE "C")` : `${right} COLLATE "C"`;
    }
    return op === 'equals' ? `${left} = ${right}` : `${left} <> ${right}`;
  }

  // lt / lte / gt / gte
  const opSql = { lt: '<', lte: '<=', gt: '>', gte: '>=' }[op];
  const p = push(values, formatParamText(oid, value, isEnum));
  let left = col(field);
  let right = `${p}::${sqlType}`;
  if (isText) {
    left = `${left} COLLATE "C"`;
    right = `${right} COLLATE "C"`;
  }
  return `${left} ${opSql} ${right}`;
}

function compileSet(node: Extract<PredicateNode, { kind: 'set' }>, values: string[]): string {
  const { field, op, values: vals } = node;
  const oid = field.typeOid;
  const isEnum = field.enumName !== null;
  const isText = isTextOid(oid);
  const sqlType = isEnum ? quoteIdent(field.typeName) : sqlTypeName(oid);
  const p = push(values, formatArrayLiteral(oid, vals, isEnum));
  const colExpr = isText ? `${col(field)} COLLATE "C"` : col(field);
  const arrExpr = isText ? `${p}::${sqlType}[] COLLATE "C"` : `${p}::${sqlType}[]`;
  const membership = `${colExpr} = ANY(${arrExpr})`;
  return op === 'in' ? membership : `(NOT ${membership})`;
}

function compileList(node: Extract<PredicateNode, { kind: 'list' }>, values: string[]): string {
  const { field, op } = node;
  const elemOid = field.elementTypeOid as number;
  const isEnum = field.enumName !== null;
  const sqlType = isEnum ? quoteIdent(field.elementTypeName!) : sqlTypeName(elemOid);
  const isText = isTextOid(elemOid);
  const colExpr = isText ? `${col(field)} COLLATE "C"` : col(field);

  if (op === 'isEmpty') {
    return `(CASE WHEN ${col(field)} IS NULL THEN NULL ELSE array_length(${col(field)}, 1) IS NULL END)`;
  }

  if (op === 'has') {
    const p = push(values, formatParamText(elemOid, node.values[0], isEnum));
    const pExpr = isText ? `${p}::${sqlType} COLLATE "C"` : `${p}::${sqlType}`;
    return `${pExpr} = ANY(${colExpr})`;
  }

  const p = push(values, formatArrayLiteral(elemOid, node.values, isEnum));
  const arrExpr = isText ? `${p}::${sqlType}[] COLLATE "C"` : `${p}::${sqlType}[]`;
  return op === 'hasSome' ? `${colExpr} && ${arrExpr}` : `${colExpr} @> ${arrExpr}`;
}
