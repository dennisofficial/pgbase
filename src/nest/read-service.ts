import { Inject, Injectable } from '@nestjs/common';
import { requireContext, type ContextStore } from '../context/index.js';
import { DEFAULT_READ_LIMITS, applyPlan, scopeRead, type ReadArgs } from '../read/index.js';
import type { Resolved } from './tokens.js';
import { PGBASE_CONTEXT_STORE, PGBASE_OPTIONS, PGBASE_RESOLVED, delegateName } from './tokens.js';
import type { PgbaseModuleOptions } from './types.js';

@Injectable()
export class PgbaseReadService {
  constructor(
    @Inject(PGBASE_OPTIONS) private readonly options: PgbaseModuleOptions,
    @Inject(PGBASE_RESOLVED) private readonly resolved: Resolved,
    @Inject(PGBASE_CONTEXT_STORE) private readonly contextStore: ContextStore,
  ) {}

  async read(model: string, args: ReadArgs): Promise<unknown> {
    const { claims } = requireContext(this.contextStore);
    const limits = this.options.limits ?? DEFAULT_READ_LIMITS;

    const scoped = scopeRead(args, model, {
      schema: this.resolved.schema,
      policies: this.resolved.policies,
      claims,
      limits,
    });

    const delegate = delegateName(model);
    const timeoutMs = Math.trunc(limits.statementTimeoutMs);
    const rows = await this.options.prisma.$transaction(async (tx: any) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
      return tx[delegate].findMany(scoped.args);
    });

    return applyPlan(scoped.plan, rows);
  }
}
