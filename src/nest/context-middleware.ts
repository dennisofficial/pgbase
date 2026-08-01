import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import {
  AsyncLocalStorageContextStore,
  MemoryClaimsCache,
  toPgbaseRequest,
} from '../context/index.js';
import { PGBASE_OPTIONS } from './tokens.js';
import type { PgbaseModuleOptions } from './types.js';

@Injectable()
export class PgbaseContextMiddleware implements NestMiddleware {
  constructor(
    @Inject(PGBASE_OPTIONS) private readonly options: PgbaseModuleOptions,
    private readonly claimsCache: MemoryClaimsCache,
    private readonly contextStore: AsyncLocalStorageContextStore,
  ) {}

  async use(req: unknown, _res: unknown, next: (err?: unknown) => void): Promise<void> {
    if ((req as { method?: string }).method === 'OPTIONS') {
      next();
      return;
    }

    try {
      const principal = this.options.getPrincipal(toPgbaseRequest(req, 'http'));
      const claims = await this.claimsCache.get(principal);
      this.contextStore.run({ principal, claims }, () => next());
    } catch (err) {
      next(err);
    }
  }
}
