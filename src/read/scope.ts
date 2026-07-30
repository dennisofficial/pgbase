import { scopedWhere } from '../context/scoped-write.js';
import { normalizeClientWhere } from '../policy/filterable.js';
import { buildProjector } from '../policy/project.js';
import type { ProbeResult } from '../policy/types.js';
import type { ValidatedPolicy } from '../policy/validate.js';
import type { LiveWhere } from '../query/ast.js';
import { QueryError } from '../query/errors.js';
import type { ResolvedModel, ResolvedSchema } from '../schema/types.js';
import { ReadValidationError, type ReadArgs, type ReadLimits, type ResultPlan } from './types.js';

export interface ReadContext<Claims = unknown> {
  readonly schema: ResolvedSchema;
  readonly policies: ReadonlyMap<string, ValidatedPolicy>;
  readonly claims: Claims;
  readonly limits: ReadLimits;
}

type Cardinality = 'root' | 'one' | 'many';

interface Level {
  readonly args: ReadArgs;
  readonly plan: ResultPlan;
}

export function scopeRead<Claims>(
  args: ReadArgs,
  rootModel: string,
  ctx: ReadContext<Claims>,
): Level {
  const model = ctx.schema.byModel.get(rootModel);
  if (!model) {
    throw new ReadValidationError(
      rootModel,
      '',
      `Model "${rootModel}" is not part of the resolved schema.`,
    );
  }
  return scopeLevel(model, args, '', ctx, 'root');
}

function scopeLevel<Claims>(
  model: ResolvedModel,
  raw: ReadArgs,
  path: string,
  ctx: ReadContext<Claims>,
  cardinality: Cardinality,
): Level {
  const validated = ctx.policies.get(model.model);
  if (!validated) {
    throw new ReadValidationError(
      model.model,
      path,
      `Model "${model.model}" at "${label(path)}" has no client-accessible policy — either ` +
        `NO_CLIENT_ACCESS or missing from the registry. A model without a policy cannot be read.`,
    );
  }
  const { policy, probeResult } = validated;

  if (raw.select && raw.include) {
    throw new ReadValidationError(
      model.model,
      path,
      `Model "${model.model}" at "${label(path)}": "select" and "include" cannot both be set.`,
    );
  }

  validateScalarSelect(raw.select, model, probeResult, path);

  const clientWhere = validateWhere(raw.where, model, probeResult, path);
  const where = scopedWhere(policy, ctx.claims, clientWhere ?? {});

  const orderBy = validateOrderBy(raw.orderBy, probeResult, model, path);
  const cursor = validateCursor(raw.cursor, probeResult, model, path);
  const distinct = validateDistinct(raw.distinct, probeResult, model, path);
  const take = clampTake(raw.take, ctx.limits, model, path, cardinality);
  const skip = validateSkip(raw.skip, model, path, cardinality);

  const { include, relations, hasCount } = walkRelations(model, raw, path, ctx);

  const args: ReadArgs = { where };
  if (orderBy !== undefined) args.orderBy = orderBy;
  if (cursor !== undefined) args.cursor = cursor;
  if (distinct !== undefined) args.distinct = distinct;
  if (take !== undefined) args.take = take;
  if (skip !== undefined) args.skip = skip;
  if (include) args.include = include;

  const project = withCount(buildProjector(model, policy), hasCount);
  const plan: ResultPlan = { model: model.model, project, relations };

  return { args, plan };
}

function label(path: string): string {
  return path || '<root>';
}

// ─────────────────────────────────────────────────────────────────────────────
// where / orderBy / cursor / distinct — client input validated against filterable
// ─────────────────────────────────────────────────────────────────────────────

function validateWhere(
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

function validateOrderBy(
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

function validateCursor(
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

function validateDistinct(
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

function validateScalarSelect(
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

function clampTake(
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

function validateSkip(
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

// ─────────────────────────────────────────────────────────────────────────────
// select/include → relations, always rewritten as `include` (transform needs the full row)
// ─────────────────────────────────────────────────────────────────────────────

interface WalkedRelations {
  readonly include: Record<string, unknown> | undefined;
  readonly relations: Map<string, ResultPlan>;
  readonly hasCount: boolean;
}

function walkRelations<Claims>(
  model: ResolvedModel,
  raw: ReadArgs,
  path: string,
  ctx: ReadContext<Claims>,
): WalkedRelations {
  const source = raw.select ?? raw.include;
  const relations = new Map<string, ResultPlan>();
  if (!source) return { include: undefined, relations, hasCount: false };

  const isSelect = raw.select !== undefined;
  const relationsByName = new Map(model.relations.map((r) => [r.name, r] as const));
  const include: Record<string, unknown> = {};
  let hasCount = false;

  for (const [key, value] of Object.entries(source)) {
    if (value === false || value === undefined) continue;

    if (key === '_count') {
      include['_count'] = buildCount(model, value, path, ctx);
      hasCount = true;
      continue;
    }

    const relation = relationsByName.get(key);
    if (!relation) {
      if (isSelect) continue; // already validated (or rejected) as a scalar field
      throw new ReadValidationError(
        model.model,
        path,
        `Model "${model.model}" at "${label(path)}": "${key}" is not a relation on this model; only ` +
          `relations (and "_count") may appear in "include".`,
      );
    }

    const target = ctx.schema.byModel.get(relation.targetModel);
    if (!target) {
      throw new ReadValidationError(
        model.model,
        path,
        `Model "${model.model}" at "${label(path)}": relation "${key}" targets unknown model ` +
          `"${relation.targetModel}".`,
      );
    }

    const nestedPath = path ? `${path}.${key}` : key;
    const nestedRaw = normalizeNestedValue(value, model, key, nestedPath);
    const cardinality: Cardinality = relation.cardinality === 'many' ? 'many' : 'one';
    const nested = scopeLevel(target, nestedRaw, nestedPath, ctx, cardinality);

    include[key] = Object.keys(nested.args).length > 0 ? nested.args : true;
    relations.set(key, nested.plan);
  }

  return { include: Object.keys(include).length > 0 ? include : undefined, relations, hasCount };
}

function normalizeNestedValue(
  raw: unknown,
  model: ResolvedModel,
  key: string,
  path: string,
): ReadArgs {
  if (raw === true) return {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as ReadArgs;
  throw new ReadValidationError(
    model.model,
    path,
    `Model "${model.model}" at "${label(path)}": relation "${key}" must be "true" or a nested ` +
      `query object.`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// _count — only over relations whose target model has a client-accessible policy
// ─────────────────────────────────────────────────────────────────────────────

function buildCount<Claims>(
  model: ResolvedModel,
  raw: unknown,
  path: string,
  ctx: ReadContext<Claims>,
): unknown {
  if (raw === true) {
    throw new ReadValidationError(
      model.model,
      path,
      `Model "${model.model}" at "${label(path)}": "_count: true" counts every relation ` +
        `indiscriminately; use "_count: { select: { <relation>: true } }" so each counted relation ` +
        `can be checked for a policy.`,
    );
  }
  if (typeof raw !== 'object' || raw === null || !('select' in raw)) {
    throw new ReadValidationError(
      model.model,
      path,
      `Model "${model.model}" at "${label(path)}": "_count" must be "{ select: { ... } }".`,
    );
  }
  const select = (raw as { select: unknown }).select;
  if (typeof select !== 'object' || select === null) {
    throw new ReadValidationError(
      model.model,
      path,
      `Model "${model.model}" at "${label(path)}": "_count.select" must be an object.`,
    );
  }

  const relationsByName = new Map(model.relations.map((r) => [r.name, r] as const));
  const outSelect: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(select as Record<string, unknown>)) {
    if (value === false || value === undefined) continue;

    const relation = relationsByName.get(key);
    if (!relation) {
      throw new ReadValidationError(
        model.model,
        path,
        `Model "${model.model}" at "${label(path)}": "_count" references unknown relation "${key}".`,
      );
    }
    const targetValidated = ctx.policies.get(relation.targetModel);
    if (!targetValidated) {
      throw new ReadValidationError(
        model.model,
        path,
        `Model "${model.model}" at "${label(path)}": "_count" over relation "${key}" reaches model ` +
          `"${relation.targetModel}", which has no client-accessible policy.`,
      );
    }
    if (value === true) {
      outSelect[key] = true;
      continue;
    }

    const target = ctx.schema.byModel.get(relation.targetModel)!;
    const nestedPath = path ? `${path}.${key}` : key;
    const clientWhere = (value as { where?: LiveWhere }).where;
    const validatedWhere = validateWhere(
      clientWhere,
      target,
      targetValidated.probeResult,
      nestedPath,
    );
    outSelect[key] = {
      where: scopedWhere(targetValidated.policy, ctx.claims, validatedWhere ?? {}),
    };
  }

  return { select: outSelect };
}

// ─────────────────────────────────────────────────────────────────────────────
// _count is a plain number pulled from Prisma's row, not a policy-governed relation — merge it
// back onto the projected view rather than teaching ResultPlan a second kind of node.
// ─────────────────────────────────────────────────────────────────────────────

function withCount(
  project: (row: unknown) => unknown,
  hasCount: boolean,
): (row: unknown) => unknown {
  if (!hasCount) return project;
  return (row: unknown) => {
    const view = project(row);
    if (view === null || typeof view !== 'object' || Array.isArray(view)) return view;
    const count = row && typeof row === 'object' ? (row as Record<string, unknown>)['_count'] : undefined;
    if (count === undefined) return view;
    return { ...(view as Record<string, unknown>), _count: count };
  };
}
