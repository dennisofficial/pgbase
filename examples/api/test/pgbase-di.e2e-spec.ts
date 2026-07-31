/**
 * Boots PgbaseModule for real, because the DI wiring cannot be checked any other way: `tsc` sees
 * the constructor types, but whether Nest can *resolve* them depends on `design:paramtypes`
 * surviving the build. The library is consumed here as `@dltech/pgbase/nest`, so this exercises
 * dist/ exactly as a consumer would.
 */
import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  PgCatalogSchemaProviderService,
  PgbaseModule,
  PgbaseReadService,
  PgbaseSchemaProvider,
  PgbaseSchemaRegistry,
  type PgbasePrismaClient,
} from '@dltech/pgbase/nest';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pgbaseSchema from '../src/generated/pgbase';
import { PrismaClient } from '../src/generated/prisma/client';
import { pgbasePolicies } from '../src/pgbase/policies';
import { ScopedDb } from '../src/pgbase/scoped-db';

const CONNECTION = process.env.DATABASE_URL ?? 'postgresql://pgbase:pgbase@localhost:55432/pgbase';

/** No query runs here — only the schema resolution against pg_catalog, which uses the pool. */
const stubPrisma = {
  $transaction: async (fn: (tx: PgbasePrismaClient) => Promise<unknown>) =>
    fn(stubPrisma as PgbasePrismaClient),
  $executeRawUnsafe: async () => 0,
} as unknown as PgbasePrismaClient;

describe('PgbaseModule dependency injection', () => {
  let pool: Pool;
  let ctx: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONNECTION });

    // A real client, because the scoped delegate is a `$extends` extension on one — the stub has no
    // `$extends` to extend. Constructing it opens no connection, and nothing here issues a query.
    @Module({
      imports: [
        PgbaseModule.forRoot({
          pool,
          prisma: new PrismaClient({
            adapter: new PrismaPg({ connectionString: CONNECTION }),
          }) as unknown as PgbasePrismaClient,
          schema: pgbaseSchema as never,
          policies: pgbasePolicies,
          claimsBuilder: { build: async () => ({}) } as never,
          getPrincipal: () => 'nobody',
          scopedPrisma: ScopedDb,
        }),
      ],
    })
    class HostModule {}

    ctx = await Test.createTestingModule({ imports: [HostModule] }).compile();
  });

  afterAll(async () => {
    await ctx?.close();
    await pool?.end();
  });

  it('resolves the schema registry as a class token', () => {
    const registry = ctx.get(PgbaseSchemaRegistry, { strict: false });
    expect(registry).toBeInstanceOf(PgbaseSchemaRegistry);
    expect(registry.schema.models.length).toBeGreaterThan(0);
    expect(registry.policies.size).toBeGreaterThan(0);
  });

  it('binds the pg_catalog adapter behind the SchemaProvider port by default', () => {
    const provider = ctx.get(PgbaseSchemaProvider, { strict: false });
    expect(provider).toBeInstanceOf(PgCatalogSchemaProviderService);
    expect(provider).toBeInstanceOf(PgbaseSchemaProvider);
  });

  /**
   * The registry has to be fully resolved before its consumers are constructed — a lifecycle hook
   * would hand them an empty one, since the scoped client reads the schema while it is being built.
   */
  it('injects one fully-resolved registry into every consumer', () => {
    const registry = ctx.get(PgbaseSchemaRegistry, { strict: false });
    const reads = ctx.get(PgbaseReadService, { strict: false });

    expect(Reflect.get(reads, 'resolved')).toBe(registry);
    expect(Reflect.get(reads, 'contextStore')).toBeDefined();
  });

  /**
   * The scoped delegate is built during instantiation, so a broken registry or context store shows
   * up as a boot failure rather than a bad query — which is the whole reason to resolve it here.
   */
  it('resolves the scoped client, carrying the operations the extension scopes', () => {
    const db = ctx.get(ScopedDb, { strict: false });
    for (const operation of ['findMany', 'findUnique', 'count', 'create', 'update', 'delete']) {
      expect(typeof (db.job as Record<string, unknown>)[operation]).toBe('function');
    }
  });

  it('hands every request the same scoped client instance', () => {
    expect(ctx.get(ScopedDb, { strict: false })).toBe(ctx.get(ScopedDb, { strict: false }));
  });
});

/**
 * §14.8 replaces pg_catalog introspection with a schema emitted at `prisma generate` time. That
 * only works if the provider is swappable, so the seam is asserted now rather than discovered
 * later — including the part that matters most: booting with no reachable database.
 */
describe('PgbaseModule with a substituted schema provider', () => {
  it('never touches the database when the schema is supplied', async () => {
    const donor = new Pool({ connectionString: CONNECTION });
    const realRegistry = await bootRegistry(donor);
    await donor.end();

    let calls = 0;

    @Injectable()
    class CannedSchemaProvider extends PgbaseSchemaProvider {
      async resolve() {
        calls += 1;
        return realRegistry.schema;
      }
    }

    // Nothing is listening here. If anything reaches for the pool, the boot fails.
    const deadPool = new Pool({
      connectionString: 'postgresql://nobody:nobody@127.0.0.1:1/nowhere',
      connectionTimeoutMillis: 500,
    });

    @Module({
      imports: [
        PgbaseModule.forRoot({
          pool: deadPool,
          prisma: stubPrisma,
          schema: pgbaseSchema as never,
          policies: pgbasePolicies,
          claimsBuilder: { build: async () => ({}) } as never,
          getPrincipal: () => 'nobody',
          schemaProvider: CannedSchemaProvider,
        }),
      ],
    })
    class HostModule {}

    const ctx = await Test.createTestingModule({ imports: [HostModule] }).compile();

    expect(calls).toBe(1);
    expect(ctx.get(PgbaseSchemaProvider, { strict: false })).toBeInstanceOf(CannedSchemaProvider);
    expect(ctx.get(PgbaseSchemaRegistry, { strict: false }).schema).toBe(realRegistry.schema);
    expect(ctx.get(PgbaseSchemaRegistry, { strict: false }).policies.size).toBeGreaterThan(0);

    await ctx.close();
    await deadPool.end();
  });
});

async function bootRegistry(pool: Pool): Promise<PgbaseSchemaRegistry> {
  @Module({
    imports: [
      PgbaseModule.forRoot({
        pool,
        prisma: stubPrisma,
        schema: pgbaseSchema as never,
        policies: pgbasePolicies,
        claimsBuilder: { build: async () => ({}) } as never,
        getPrincipal: () => 'nobody',
      }),
    ],
  })
  class DonorModule {}

  const ctx = await Test.createTestingModule({ imports: [DonorModule] }).compile();
  const registry = ctx.get(PgbaseSchemaRegistry, { strict: false });
  await ctx.close();
  return registry;
}
