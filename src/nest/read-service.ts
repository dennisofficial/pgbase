import { Inject, Injectable } from '@nestjs/common';
import { AsyncLocalStorageContextStore, requireContext } from '../context/index.js';
import { DEFAULT_READ_LIMITS, applyPlan, scopeRead, type ReadArgs } from '../read/index.js';
import { PgbaseSchemaRegistry } from './schema-registry.js';
import { PGBASE_OPTIONS, delegateName } from './tokens.js';
import type { PgbaseModuleOptions } from './types.js';

@Injectable()
export class PgbaseReadService {
  constructor(
    @Inject(PGBASE_OPTIONS) private readonly options: PgbaseModuleOptions,
    private readonly resolved: PgbaseSchemaRegistry,
    private readonly contextStore: AsyncLocalStorageContextStore,
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
