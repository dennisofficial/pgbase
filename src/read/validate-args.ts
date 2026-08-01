import { normalizeClientWhere } from '../policy/filterable.js';
import type { ProbeResult } from '../policy/types.js';
import type { LiveWhere } from '../query/ast.js';
import { QueryError } from '../query/errors.js';
import type { ResolvedModel } from '../schema/types.js';
import { ReadValidationError, type ReadLimits } from './types.js';

export type Cardinality = 'root' | 'one' | 'many';

export function label(path: string): string {
  return path || '<root>';
}

export function validateWhere(
  where: LiveWhere | undefined,
  model: ResolvedModel,
  probeResult: ProbeResult,
  path: string,
): LiveWhere | undefined {
  if (where === undefined) return undefined;
  try {
    normalizeClientWhere(where, model, probeResult);
  } catch (err) {
    if (err instanceof QueryError) {
      throw new ReadValidationError(
        model.model,
        path,
        `Model "${model.model}" at "${label(path)}": ${err.message}`,
      );
    }
    throw err;
  }
  return where;
}

export function validateOrderBy(
  orderBy: unknown,
  probeResult: ProbeResult,
  model: ResolvedModel,
  path: string,
): unknown {
  if (orderBy === undefined) return undefined;
  const items = Array.isArray(orderBy) ? orderBy : [orderBy];
  for (const item of items) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new ReadValidationError(
        model.model,
        path,
        `Model "${model.model}" at "${label(path)}": "orderBy" entries must be objects.`,
      );
    }
    for (const [field, dir] of Object.entries(item as Record<string, unknown>)) {
      if (!probeResult.filterable.has(field)) {
        throw new ReadValidationError(
          model.model,
          path,
          `Model "${model.model}" at "${label(path)}": cannot order by "${field}" — it is not ` +
            `filterable (a hidden column would be a sort oracle).`,
        );
      }
      if (dir !== 'asc' && dir !== 'desc') {
        throw new ReadValidationError(
          model.model,
          path,
          `Model "${model.model}" at "${label(path)}": orderBy["${field}"] must be "asc" or "desc".`,
        );
      }
    }
  }
  return orderBy;
}

export function validateCursor(
  cursor: Record<string, unknown> | undefined,
  probeResult: ProbeResult,
  model: ResolvedModel,
  path: string,
): Record<string, unknown> | undefined {
  if (cursor === undefined) return undefined;
  for (const field of Object.keys(cursor)) {
    if (!probeResult.filterable.has(field)) {
      throw new ReadValidationError(
        model.model,
        path,
        `Model "${model.model}" at "${label(path)}": cannot cursor on "${field}" — it is not filterable.`,
      );
    }
  }
  return cursor;
}

export function validateDistinct(
  distinct: unknown,
  probeResult: ProbeResult,
  model: ResolvedModel,
  path: string,
): unknown {
  if (distinct === undefined) return undefined;
  const items = Array.isArray(distinct) ? distinct : [distinct];
  for (const field of items) {
    if (typeof field !== 'string' || !probeResult.filterable.has(field)) {
      throw new ReadValidationError(
        model.model,
        path,
        `Model "${model.model}" at "${label(path)}": cannot select distinct on "${String(field)}" — ` +
          `it is not filterable.`,
      );
    }
  }
  return distinct;
}

export function validateScalarSelect(
  select: Record<string, unknown> | undefined,
  model: ResolvedModel,
  probeResult: ProbeResult,
  path: string,
): void {
  if (!select) return;
  const relationNames = new Set(model.relations.map((r) => r.name));
  for (const [key, value] of Object.entries(select)) {
    if (key === '_count' || relationNames.has(key)) continue;
    if (value === false || value === undefined) continue;

    const field = model.fields.find((f) => f.name === key);
    if (!field) {
      throw new ReadValidationError(
        model.model,
        path,
        `Model "${model.model}" at "${label(path)}": unknown field "${key}" in "select".`,
      );
    }
    if (!probeResult.filterable.has(key)) {
      throw new ReadValidationError(
        model.model,
        path,
        `Model "${model.model}" at "${label(path)}": field "${key}" is omitted by this model's ` +
          `policy and cannot be selected.`,
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// take / skip
// ─────────────────────────────────────────────────────────────────────────────

export function clampTake(
  take: number | undefined,
  limits: ReadLimits,
  model: ResolvedModel,
  path: string,
  cardinality: Cardinality,
): number | undefined {
  if (cardinality === 'one') {
    if (take !== undefined) {
      throw new ReadValidationError(
        model.model,
        path,
        `Model "${model.model}" at "${label(path)}": "take" is not valid on a to-one relation.`,
      );
    }
    return undefined;
  }
  if (take === undefined) return limits.maxRows;
  if (!Number.isInteger(take) || take <= 0) {
    throw new ReadValidationError(
      model.model,
      path,
      `Model "${model.model}" at "${label(path)}": "take" must be a positive integer.`,
    );
  }
  return Math.min(take, limits.maxRows);
}

export function validateSkip(
  skip: number | undefined,
  model: ResolvedModel,
  path: string,
  cardinality: Cardinality,
): number | undefined {
  if (skip === undefined) return undefined;
  if (cardinality === 'one') {
    throw new ReadValidationError(
      model.model,
      path,
      `Model "${model.model}" at "${label(path)}": "skip" is not valid on a to-one relation.`,
    );
  }
  if (!Number.isInteger(skip) || skip < 0) {
    throw new ReadValidationError(
      model.model,
      path,
      `Model "${model.model}" at "${label(path)}": "skip" must be a non-negative integer.`,
    );
  }
  return skip;
}
