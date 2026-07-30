import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

// Prisma 7's `prisma-client` generator is driver-adapter-only for Postgres (no bundled query
// engine binary), so a `SqlDriverAdapterFactory` is required at construction time, not optional.
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
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
