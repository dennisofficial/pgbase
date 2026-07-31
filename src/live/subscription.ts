import { scopedWhere } from '../context/scoped-write.js';
import { computeFilterable } from '../policy/filterable.js';
import type { Policy } from '../policy/types.js';
import type { LiveWhere } from '../query/ast.js';
import { referencedColumns } from '../query/columns.js';
import { normalize } from '../query/normalize.js';
import type { ResolvedModel } from '../schema/types.js';
import type { ColumnRow } from '../wal/types.js';
import type { Subscription } from './types.js';

export function buildLiveProjector(
  model: ResolvedModel,
  policy: Policy<any, any, any>,
): (row: ColumnRow) => unknown {
  const omitted = new Set(policy.omit as readonly string[]);
  const visible = model.fields.filter((f) => !omitted.has(f.name));

  return (row: ColumnRow): unknown => {
    const out: Record<string, unknown> = {};
    for (const field of visible) {
      if (field.column in row) out[field.name] = row[field.column];
    }
    return out;
  };
}

export function buildIdentifier(model: ResolvedModel): (row: ColumnRow) => Record<string, unknown> {
  const keyFields = model.primaryKey.map((column) => ({
    column,
    name: model.byColumn.get(column)?.name ?? column,
  }));

  return (row: ColumnRow): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const { column, name } of keyFields) {
      if (column in row) out[name] = row[column];
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
}

export function createSubscription(input: SubscriptionInput): Subscription {
  const { id, model, policy, claims, where = {} } = input;
  const filterable = computeFilterable(model, policy).filterable;

  // The client's own filter is held to the filterable set, so an omitted column cannot be read one
  // character at a time through a `startsWith` oracle. The policy's predicate is server-authored
  // and is held to the model instead: a policy that omits the very column its RLS scopes on — an
  // actor id that is always the caller, say — is a normal thing to write, and rejecting it here
  // would make the model unsubscribable while one-shot reads of it kept working.
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
    project: buildLiveProjector(model, policy),
    identify: buildIdentifier(model),
  };
}
