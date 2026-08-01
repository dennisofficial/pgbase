import { scopedWhere } from '../context/scoped-write.js';
import { buildProjector } from '../policy/project.js';
import type { ValidatedPolicy } from '../policy/validate.js';
import type { LiveWhere } from '../query/ast.js';
import type { ResolvedModel, ResolvedSchema } from '../schema/types.js';
import { ReadValidationError, type ReadArgs, type ReadLimits, type ResultPlan } from './types.js';
import {
  clampTake,
  label,
  validateCursor,
  validateDistinct,
  validateOrderBy,
  validateScalarSelect,
  validateSkip,
  validateWhere,
  type Cardinality,
} from './validate-args.js';

export type ReadProfile = 'client' | 'server';

export interface ReadContext<Claims = unknown> {
  readonly schema: ResolvedSchema;
  readonly policies: ReadonlyMap<string, ValidatedPolicy>;
  readonly claims: Claims;
  readonly limits: ReadLimits;
  readonly profile?: ReadProfile;
}

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
  const trusted = ctx.profile === 'server';

  if (raw.select && raw.include) {
    throw new ReadValidationError(
      model.model,
      path,
      `Model "${model.model}" at "${label(path)}": "select" and "include" cannot both be set.`,
    );
  }

  if (!trusted) validateScalarSelect(raw.select, model, probeResult, path);

  const callerWhere = trusted ? raw.where : validateWhere(raw.where, model, probeResult, path);
  const where = scopedWhere(policy, ctx.claims, callerWhere ?? {});

  const orderBy = trusted ? raw.orderBy : validateOrderBy(raw.orderBy, probeResult, model, path);
  const cursor = trusted ? raw.cursor : validateCursor(raw.cursor, probeResult, model, path);
  const distinct = trusted
    ? raw.distinct
    : validateDistinct(raw.distinct, probeResult, model, path);
  const take = trusted ? raw.take : clampTake(raw.take, ctx.limits, model, path, cardinality);
  const skip = trusted ? raw.skip : validateSkip(raw.skip, model, path, cardinality);

  const walked = walkRelations(model, raw, path, ctx);

  const args: ReadArgs = { where };
  if (orderBy !== undefined) args.orderBy = orderBy;
  if (cursor !== undefined) args.cursor = cursor;
  if (distinct !== undefined) args.distinct = distinct;
  if (take !== undefined) args.take = take;
  if (skip !== undefined) args.skip = skip;
  if (walked.select) args.select = walked.select;
  if (walked.include) args.include = walked.include;

  const plan: ResultPlan = trusted
    ? { model: model.model, project: passThrough, relations: new Map() }
    : {
        model: model.model,
        project: withCount(buildProjector(model, policy), walked.hasCount),
        relations: walked.relations,
      };

  return { args, plan };
}

function passThrough(row: unknown): unknown {
  return row;
}

interface WalkedRelations {
  readonly select?: Record<string, unknown>;
  readonly include?: Record<string, unknown>;
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
  if (!source) return { relations, hasCount: false };

  const trusted = ctx.profile === 'server';
  const isSelect = raw.select !== undefined;
  const relationsByName = new Map(model.relations.map((r) => [r.name, r] as const));
  const out: Record<string, unknown> = {};
  let hasCount = false;

  for (const [key, value] of Object.entries(source)) {
    if (value === false || value === undefined) {
      if (trusted) out[key] = value;
      continue;
    }

    if (key === '_count') {
      out['_count'] = buildCount(model, value, path, ctx);
      hasCount = true;
      continue;
    }

    const relation = relationsByName.get(key);
    if (!relation) {
      if (isSelect) {
        if (trusted) out[key] = value;
        continue;
      }
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

    out[key] = Object.keys(nested.args).length > 0 ? nested.args : true;
    relations.set(key, nested.plan);
  }

  if (Object.keys(out).length === 0) return { relations, hasCount };
  return trusted && isSelect
    ? { select: out, relations, hasCount }
    : { include: out, relations, hasCount };
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
      outSelect[key] = { where: scopedWhere(targetValidated.policy, ctx.claims, {}) };
      continue;
    }

    const target = ctx.schema.byModel.get(relation.targetModel)!;
    const nestedPath = path ? `${path}.${key}` : key;
    const callerWhere = (value as { where?: LiveWhere }).where;
    const checked =
      ctx.profile === 'server'
        ? callerWhere
        : validateWhere(callerWhere, target, targetValidated.probeResult, nestedPath);
    outSelect[key] = {
      where: scopedWhere(targetValidated.policy, ctx.claims, checked ?? {}),
    };
  }

  return { select: outSelect };
}

function withCount(
  project: (row: unknown) => unknown,
  hasCount: boolean,
): (row: unknown) => unknown {
  if (!hasCount) return project;
  return (row: unknown) => {
    const view = project(row);
    if (view === null || typeof view !== 'object' || Array.isArray(view)) return view;
    const count =
      row && typeof row === 'object' ? (row as Record<string, unknown>)['_count'] : undefined;
    if (count === undefined) return view;
    return { ...(view as Record<string, unknown>), _count: count };
  };
}
