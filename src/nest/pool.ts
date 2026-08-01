import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
import { PGBASE_OPTIONS } from './tokens.js';
import type { PgbaseModuleOptions } from './types.js';

@Injectable()
export class PgbasePoolHost implements OnApplicationShutdown {
  readonly pool: Pool;
  private readonly owned: boolean;

  constructor(@Inject(PGBASE_OPTIONS) options: PgbaseModuleOptions) {
    if (options.pool && options.connectionString) {
      throw new Error(
        'PgbaseModule: pass either "pool" or "connectionString", not both. With both, the ' +
          'connection string would be silently ignored and the pool would win.',
      );
    }
    if (options.pool) {
      this.pool = options.pool;
      this.owned = false;
      return;
    }
    if (!options.connectionString) {
      throw new Error(
        'PgbaseModule: no database connection. Pass "connectionString" and pgbase will build the ' +
          'pool it reads pg_catalog through, or pass "pool" to hand it one you already own.',
      );
    }
    this.pool = new Pool({ connectionString: options.connectionString });
    this.owned = true;
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.owned) await this.pool.end();
  }
}
