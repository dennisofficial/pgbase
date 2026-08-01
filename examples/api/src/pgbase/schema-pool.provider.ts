import { Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import type { EnvConfig } from '../config/env.config';

export const SCHEMA_POOL = Symbol('SCHEMA_POOL');

@Injectable()
export class SchemaPoolShutdown implements OnApplicationShutdown {
  constructor(@Inject(SCHEMA_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

/** Separate from the Prisma client on purpose: pgbase reads `pg_catalog` over a plain pool. */
@Module({
  providers: [
    {
      provide: SCHEMA_POOL,
      useFactory: (config: ConfigService<EnvConfig, true>) =>
        new Pool({ connectionString: config.get('DATABASE_URL', { infer: true }) }),
      inject: [ConfigService],
    },
    SchemaPoolShutdown,
  ],
  exports: [SCHEMA_POOL],
})
export class SchemaPoolModule {}
