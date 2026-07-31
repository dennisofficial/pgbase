import {
  ScopeViolationError,
  assertCreateInScope,
  assertUpdateStaysInScope,
  requireContext,
  scopedWhere,
  type ContextStore,
} from '../context/index.js';
import type { Policy } from '../policy/index.js';
import { NO_CLIENT_ACCESS } from '../policy/index.js';
import type { LiveWhere } from '../query/ast.js';
import { scopeRead, type ReadArgs, type ReadLimits } from '../read/index.js';
import type { ResolvedModel } from '../schema/index.js';
import { ScopedRowNotFoundError } from './scoped-errors.js';
import { delegateName, type Resolved } from './tokens.js';
import type { PgbasePrismaClient } from './types.js';

const NESTED_READS = new Set(['findMany', 'findFirst', 'findFirstOrThrow']);
const UNIQUE_READS = new Set(['findUnique', 'findUniqueOrThrow']);
const WHERE_ONLY_READS = new Set(['count', 'aggregate', 'groupBy']);

const DEFERRED_OPERATIONS: Record<string, string> = {
  upsert: 'upsert both creates and updates, and each half needs its own scope proof',
  updateMany: 'a bulk update has no single post-image to prove stayed in scope',
  updateManyAndReturn: 'a bulk update has no single post-image to prove stayed in scope',
  deleteMany: 'a bulk delete cannot prove every matched row was the caller’s',
  createMany: 'a bulk create needs each row proven in scope, not just the first',
  createManyAndReturn: 'a bulk create needs each row proven in scope, not just the first',
};

export interface ScopedRuntime {
  readonly base: PgbasePrismaClient;
  readonly resolved: Resolved;
  readonly contextStore: ContextStore;
  readonly limits: ReadLimits;
}

interface OperationParams {
  readonly model: string;
  readonly operation: string;
  readonly args: Record<string, unknown>;
  readonly query: (args: unknown) => Promise<unknown>;
}

export function createScopedClient(runtime: ScopedRuntime): unknown {
  return (runtime.base as unknown as ExtendableClient).$extends({
    query: {
      $allModels: {
        $allOperations: (params: OperationParams) => dispatch(runtime, params),
      },
    },
  });
}

interface ExtendableClient {
  $extends(extension: unknown): unknown;
}

async function dispatch(rt: ScopedRuntime, params: OperationParams): Promise<unknown> {
  const { model, operation, args, query } = params;

  const deferred = DEFERRED_OPERATIONS[operation];
  if (deferred) {
    throw new ScopeViolationError(
      model,
      'update',
      `"${model}.${operation}" is not scoped yet — ${deferred}. Use the operations that are ` +
        `(findMany, findFirst, findUnique, count, aggregate, groupBy, create, update, delete), or ` +
        `reach for your PrismaClient directly and enforce scope at the call site.`,
    );
  }

  const { policy, resolvedModel } = policyFor(rt.resolved, model, operation);
  // Read per call, never at construction: AsyncLocalStorage is what keeps concurrent requests apart.
  const { claims } = requireContext(rt.contextStore);

  if (NESTED_READS.has(operation)) {
    const scoped = scopeRead((args ?? {}) as ReadArgs, model, readContext(rt, claims));
    return query({ ...args, ...scoped.args });
  }

  if (UNIQUE_READS.has(operation)) {
    return uniqueRead(rt, model, operation, args, claims);
  }

  if (WHERE_ONLY_READS.has(operation)) {
    const where = scopedWhere(policy, claims, (args?.['where'] ?? {}) as LiveWhere);
    return query({ ...args, where });
  }

  if (operation === 'create') {
    const data = (args?.['data'] ?? {}) as Record<string, unknown>;
    assertNoNestedWrite(resolvedModel, data, 'create');
    assertCreateInScope(policy, claims, resolvedModel, data);
    return query(args);
  }

  if (operation === 'update') {
    return scopedUpdate(rt, model, args, policy, resolvedModel, claims);
  }

  if (operation === 'delete') {
    return scopedDelete(rt, model, args, policy, claims);
  }

  throw new ScopeViolationError(
    model,
    'update',
    `"${model}.${operation}" has no scoping rule, so it cannot be run through the scoped client. ` +
      `This is a gap in pgbase, not in your code — use your PrismaClient directly for now.`,
  );
}

function readContext(rt: ScopedRuntime, claims: unknown) {
  return {
    schema: rt.resolved.schema,
    policies: rt.resolved.policies,
    claims,
    limits: rt.limits,
    profile: 'server' as const,
  };
}

async function uniqueRead(
  rt: ScopedRuntime,
  model: string,
  operation: string,
  args: Record<string, unknown>,
  claims: unknown,
): Promise<unknown> {
  const resolvedModel = rt.resolved.schema.byModel.get(model)!;
  const where = flattenUniqueSelector(
    resolvedModel,
    (args?.['where'] ?? {}) as Record<string, unknown>,
  );
  const scoped = scopeRead({ ...args, where } as ReadArgs, model, readContext(rt, claims));
  const delegate = (rt.base as Record<string, any>)[delegateName(model)];
  const fallback = operation === 'findUniqueOrThrow' ? 'findFirstOrThrow' : 'findFirst';
  return delegate[fallback]({ ...args, ...scoped.args });
}

function flattenUniqueSelector(
  model: ResolvedModel,
  where: Record<string, unknown>,
): Record<string, unknown> {
  const fieldNames = new Set(model.fields.map((f) => f.name));
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(where)) {
    if (fieldNames.has(key) || key === 'AND' || key === 'OR' || key === 'NOT') {
      out[key] = value;
      continue;
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [part, partValue] of Object.entries(value as Record<string, unknown>)) {
        out[part] = partValue;
      }
      continue;
    }
    out[key] = value;
  }

  return out;
}

async function scopedUpdate(
  rt: ScopedRuntime,
  model: string,
  args: Record<string, unknown>,
  policy: Policy<any, any, any>,
  resolvedModel: ResolvedModel,
  claims: unknown,
): Promise<unknown> {
  const data = (args?.['data'] ?? {}) as Record<string, unknown>;
  assertNoNestedWrite(resolvedModel, data, 'update');

  const delegate = delegateName(model);
  const where = flattenUniqueSelector(
    resolvedModel,
    (args?.['where'] ?? {}) as Record<string, unknown>,
  );
  const projected = 'select' in args || 'include' in args || 'omit' in args;

  return rt.base.$transaction(async (tx: any) => {
    const current = await tx[delegate].findFirst({ where: scopedWhere(policy, claims, where) });
    if (!current) throw new ScopedRowNotFoundError(model);

    const updated = await tx[delegate].update(args);
    const postImage = projected
      ? await tx[delegate].findFirst({ where: primaryKeyOf(resolvedModel, current) })
      : updated;
    if (!postImage) throw new ScopedRowNotFoundError(model);

    assertUpdateStaysInScope(policy, claims, resolvedModel, postImage as Record<string, unknown>);
    return updated;
  });
}

async function scopedDelete(
  rt: ScopedRuntime,
  model: string,
  args: Record<string, unknown>,
  policy: Policy<any, any, any>,
  claims: unknown,
): Promise<unknown> {
  const resolvedModel = rt.resolved.schema.byModel.get(model)!;
  const delegate = delegateName(model);
  const where = flattenUniqueSelector(
    resolvedModel,
    (args?.['where'] ?? {}) as Record<string, unknown>,
  );

  return rt.base.$transaction(async (tx: any) => {
    const current = await tx[delegate].findFirst({ where: scopedWhere(policy, claims, where) });
    if (!current) throw new ScopedRowNotFoundError(model);
    return tx[delegate].delete(args);
  });
}

function primaryKeyOf(model: ResolvedModel, row: Record<string, unknown>): Record<string, unknown> {
  const key: Record<string, unknown> = {};
  for (const column of model.primaryKey) {
    const field = model.byColumn.get(column);
    if (field) key[field.name] = row[field.name];
  }
  return key;
}

function assertNoNestedWrite(
  model: ResolvedModel,
  data: Record<string, unknown>,
  kind: 'create' | 'update',
): void {
  if (!data || typeof data !== 'object') return;
  const relationNames = new Set(model.relations.map((r) => r.name));

  for (const [key, value] of Object.entries(data)) {
    if (!relationNames.has(key)) continue;
    if (value === null || typeof value !== 'object') continue;

    throw new ScopeViolationError(
      model.model,
      kind,
      `Model "${model.model}": "${key}" is a nested write, and the scoped client cannot prove the ` +
        `rows it touches are in scope — its policy is never consulted. Set the foreign key ` +
        `directly, or write the related rows through their own scoped delegate.`,
    );
  }
}

function policyFor(
  resolved: Resolved,
  model: string,
  operation: string,
): { policy: Policy<any, any, any>; resolvedModel: ResolvedModel } {
  const validated = resolved.policies.get(model);
  const resolvedModel = resolved.schema.byModel.get(model);
  if (!validated || !resolvedModel || (validated.policy as unknown) === NO_CLIENT_ACCESS) {
    throw new ScopeViolationError(
      model,
      'update',
      `Model "${model}" has no client-accessible policy, so "${operation}" has no RLS predicate to ` +
        `scope to. Use your PrismaClient directly for work that has no caller to scope to.`,
    );
  }
  return { policy: validated.policy, resolvedModel };
}
