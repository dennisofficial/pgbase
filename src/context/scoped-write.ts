import type { Policy } from '../policy/types.js';
import type { LiveWhere } from '../query/ast.js';
import { referencedColumns } from '../query/columns.js';
import { evaluate } from '../query/evaluate.js';
import { normalize } from '../query/normalize.js';
import type { ResolvedModel } from '../schema/types.js';
import { type WriteKind, ScopeViolationError } from './types.js';

function toColumnRow(
  model: ResolvedModel,
  fieldRow: Record<string, unknown>,
): Record<string, unknown> {
  const columnRow: Record<string, unknown> = {};
  for (const field of model.fields) {
    if (field.name in fieldRow) columnRow[field.column] = fieldRow[field.name];
  }
  return columnRow;
}

function checkInScope(
  kind: WriteKind,
  policy: Policy<any, any, any>,
  claims: unknown,
  model: ResolvedModel,
  fieldRow: Record<string, unknown>,
): void {
  const allowedFields = new Set(model.fields.map((f) => f.name));
  const predicate = normalize(policy.rls(claims), model, allowedFields);
  const columnRow = toColumnRow(model, fieldRow);

  const missing = [...referencedColumns(predicate)].filter((c) => !(c in columnRow));
  if (missing.length > 0) {
    const fields = missing.map((c) => model.byColumn.get(c)?.name ?? c);
    throw new ScopeViolationError(
      model.model,
      kind,
      `Model "${model.model}": RLS references ${fields.map((f) => `"${f}"`).join(', ')}, which ` +
        `this ${kind} payload does not set, so the row cannot be proven in scope. Include ` +
        `${fields.length > 1 ? 'those fields' : 'that field'} in the payload, or write an RLS ` +
        `predicate over fields the payload always sets.`,
    );
  }

  let inScope: boolean;
  try {
    inScope = evaluate(predicate, columnRow);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ScopeViolationError(
      model.model,
      kind,
      `Model "${model.model}": could not prove the ${kind} row is within RLS scope (${message}). ` +
        `A row that cannot be proven in scope must not be written.`,
    );
  }

  if (!inScope) {
    throw new ScopeViolationError(
      model.model,
      kind,
      `Model "${model.model}": the ${kind === 'create' ? 'row to create' : 'row after this update'} ` +
        `does not satisfy RLS for these claims. Writing a row you would not then be allowed to ` +
        `read is a scope escape, not a convenience.`,
    );
  }
}

export function assertCreateInScope<Claims>(
  policy: Policy<any, any, Claims>,
  claims: Claims,
  model: ResolvedModel,
  row: Record<string, unknown>,
): void {
  checkInScope('create', policy, claims, model, row);
}

export function assertUpdateStaysInScope<Claims>(
  policy: Policy<any, any, Claims>,
  claims: Claims,
  model: ResolvedModel,
  postImage: Record<string, unknown>,
): void {
  checkInScope('update', policy, claims, model, postImage);
}

export function scopedWhere<Claims>(
  policy: Policy<any, any, Claims>,
  claims: Claims,
  userWhere: LiveWhere,
): LiveWhere {
  return { AND: [policy.rls(claims), userWhere] };
}
