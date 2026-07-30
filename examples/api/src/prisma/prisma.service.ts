import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

// Prisma 7's `prisma-client` generator is driver-adapter-only for Postgres (no bundled query
// engine binary), so a `SqlDriverAdapterFactory` is required at construction time, not optional.
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      // Fail here with something actionable. Passing `undefined` through to PrismaPg surfaces
      // much later as an unrelated-looking connection error.
      throw new Error(
        'DATABASE_URL is not set. Copy examples/api/.env.example to examples/api/.env ' +
          '(and run `pnpm example:up` to start Postgres).',
      );
    }
    super({ adapter: new PrismaPg({ connectionString }) });
  }

  async onModuleInit() {
    await this.$connect();
  }

  // Paired with `app.enableShutdownHooks()` in main.ts: Nest calls onModuleDestroy on every
  // provider when the app shuts down, which is what actually closes the pool.
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
