import { Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

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
      useFactory: (config: ConfigService) => {
        const connectionString = config.get<string>('DATABASE_URL');
        if (!connectionString) {
          throw new Error('DATABASE_URL is not set — see examples/api/.env.example.');
        }
        return new Pool({ connectionString });
      },
      inject: [ConfigService],
    },
    SchemaPoolShutdown,
  ],
  exports: [SCHEMA_POOL],
})
export class SchemaPoolModule {}
