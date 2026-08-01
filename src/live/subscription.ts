import { scopedWhere } from '../context/scoped-write.js';
import { computeFilterable } from '../policy/filterable.js';
import type { Policy } from '../policy/types.js';
import type { LiveWhere } from '../query/ast.js';
import { referencedColumns } from '../query/columns.js';
import { normalize } from '../query/normalize.js';
import type { ResolvedModel } from '../schema/types.js';
import { encodeColumn, type RowEncodeOptions } from '../wal/encode.js';
import type { ColumnRow } from '../wal/types.js';
import type { Subscription } from './types.js';

export function buildLiveProjector(
  model: ResolvedModel,
  policy: Policy<any, any, any>,
  encode: RowEncodeOptions = {},
): (row: ColumnRow) => unknown {
  const omitted = new Set(policy.omit as readonly string[]);
  const visible = model.fields.filter((f) => !omitted.has(f.name));

  return (row: ColumnRow): unknown => {
    const out: Record<string, unknown> = {};
    for (const field of visible) {
      if (field.column in row) out[field.name] = encodeColumn(field, row[field.column], encode);
    }
    return out;
  };
}

export function buildIdentifier(
  model: ResolvedModel,
  encode: RowEncodeOptions = {},
): (row: ColumnRow) => Record<string, unknown> {
  const keyFields = model.primaryKey.map((column) => ({
    column,
    field: model.byColumn.get(column) ?? null,
  }));

  return (row: ColumnRow): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const { column, field } of keyFields) {
      if (!(column in row)) continue;
      out[field?.name ?? column] = field ? encodeColumn(field, row[column], encode) : row[column];
    }
    return out;
  };
}

export interface SubscriptionInput {
  readonly id: string;
  readonly model: ResolvedModel;
  readonly policy: Policy<any, any, any>;
  readonly claims: unknown;
  readonly where?: Record<string, unknown>;
  readonly encode?: RowEncodeOptions;
}

export function createSubscription(input: SubscriptionInput): Subscription {
  const { id, model, policy, claims, where = {}, encode = {} } = input;
  const filterable = computeFilterable(model, policy).filterable;

  normalize(where as LiveWhere, model, filterable);

  const allFields = new Set(model.fields.map((f) => f.name));
  const predicate = normalize(scopedWhere(policy, claims, where), model, allFields);
  const rlsPredicate = normalize(policy.rls(claims), model, allFields);

  return {
    id,
    model: model.model,
    predicate,
    predicateColumns: referencedColumns(predicate),
    rlsPredicate,
    rlsColumns: referencedColumns(rlsPredicate),
    project: buildLiveProjector(model, policy, encode),
    identify: buildIdentifier(model, encode),
  };
}
