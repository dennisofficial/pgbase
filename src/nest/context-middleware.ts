import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { MemoryClaimsCache, type ContextStore } from '../context/index.js';
import { PGBASE_CLAIMS_CACHE, PGBASE_CONTEXT_STORE, PGBASE_OPTIONS } from './tokens.js';
import type { PgbaseModuleOptions } from './types.js';

@Injectable()
export class PgbaseContextMiddleware implements NestMiddleware {
  constructor(
    @Inject(PGBASE_OPTIONS) private readonly options: PgbaseModuleOptions,
    @Inject(PGBASE_CLAIMS_CACHE) private readonly claimsCache: MemoryClaimsCache,
    @Inject(PGBASE_CONTEXT_STORE) private readonly contextStore: ContextStore,
  ) {}

  async use(req: unknown, _res: unknown, next: (err?: unknown) => void): Promise<void> {
    try {
      const principal = this.options.getPrincipal(req);
      const claims = await this.claimsCache.get(principal);
      this.contextStore.run({ principal, claims }, () => next());
    } catch (err) {
      next(err);
    }
  }
}
