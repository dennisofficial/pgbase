import {
  Module,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestModule,
  type Provider,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AsyncLocalStorageContextStore, MemoryClaimsCache } from '../context/index.js';
import type { PolicyEntry } from '../policy/index.js';
import { validatePolicies } from '../policy/index.js';
import { createWireCodec } from '../read/index.js';
import { PgCatalogSchemaProvider } from '../schema/index.js';
import { PgbaseContextMiddleware } from './context-middleware.js';
import { PgbaseExceptionFilter } from './exception-filter.js';
import { createPgbaseReadController } from './read-controller.js';
import { PgbaseReadService } from './read-service.js';
import { ScopedPrismaFactory, createScopedPrismaProvider } from './scoped-prisma.js';
import {
  PGBASE_CLAIMS_CACHE,
  PGBASE_CONTEXT_STORE,
  PGBASE_OPTIONS,
  PGBASE_RESOLVED,
  PGBASE_WIRE_CODEC,
  type Resolved,
} from './tokens.js';
import type { PgbaseModuleAsyncOptions, PgbaseModuleOptions, PgbasePrismaClient } from './types.js';

export { PgbaseContextMiddleware } from './context-middleware.js';
export { PgbaseExceptionFilter } from './exception-filter.js';
export { PgbaseReadService } from './read-service.js';
export { ScopedPrismaToken } from './scoped-prisma.js';
export type { ScopedPrisma, ScopedPrismaService, ScopedPrismaTokenClass } from './scoped-prisma.js';
export type {
  PgbaseModuleAsyncOptions,
  PgbaseModuleOptions,
  PgbasePrismaClient,
  PgbaseRuntimeOptions,
} from './types.js';

const DEFAULT_ROUTE_PREFIX = 'pgbase';

@Module({})
export class PgbaseModule implements NestModule {
  static forRoot<
    Principal,
    Claims,
    Client extends PgbasePrismaClient = PgbasePrismaClient,
    Registry extends Record<string, PolicyEntry<any, any, any>> = Record<
      string,
      PolicyEntry<any, any, any>
    >,
  >(options: PgbaseModuleOptions<Principal, Claims, Client, Registry>): DynamicModule {
    return PgbaseModule.forRootAsync<Principal, Claims, Client, Registry>({
      useFactory: () => options,
      scopedPrisma: options.scopedPrisma,
      routePrefix: options.routePrefix,
    });
  }

  static forRootAsync<
    Principal,
    Claims,
    Client extends PgbasePrismaClient = PgbasePrismaClient,
    Registry extends Record<string, PolicyEntry<any, any, any>> = Record<
      string,
      PolicyEntry<any, any, any>
    >,
  >(options: PgbaseModuleAsyncOptions<Principal, Claims, Client, Registry>): DynamicModule {
    const scoped: Provider[] = options.scopedPrisma
      ? [ScopedPrismaFactory, createScopedPrismaProvider(options.scopedPrisma)]
      : [];

    return {
      module: PgbaseModule,
      imports: options.imports ?? [],
      controllers: [createPgbaseReadController(options.routePrefix ?? DEFAULT_ROUTE_PREFIX)],
      providers: [
        {
          provide: PGBASE_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
        {
          provide: PGBASE_RESOLVED,
          useFactory: async (opts: PgbaseModuleOptions): Promise<Resolved> => {
            const schema = await new PgCatalogSchemaProvider(opts.schema, opts.pool, {
              publication: opts.publication,
            }).resolve();
            const policies = validatePolicies(schema, opts.policies);
            return { schema, policies };
          },
          inject: [PGBASE_OPTIONS],
        },
        { provide: PGBASE_CONTEXT_STORE, useValue: new AsyncLocalStorageContextStore() },
        {
          provide: PGBASE_CLAIMS_CACHE,
          useFactory: (opts: PgbaseModuleOptions) =>
            new MemoryClaimsCache(opts.claimsBuilder, opts.claimsCacheOptions),
          inject: [PGBASE_OPTIONS],
        },
        {
          provide: PGBASE_WIRE_CODEC,
          useFactory: (opts: PgbaseModuleOptions) =>
            createWireCodec({
              serializers: opts.serializers,
              decimalConstructor: opts.decimalConstructor,
            }),
          inject: [PGBASE_OPTIONS],
        },
        PgbaseContextMiddleware,
        PgbaseReadService,
        ...scoped,
        { provide: APP_FILTER, useClass: PgbaseExceptionFilter },
      ],
      exports: options.scopedPrisma
        ? [PgbaseReadService, options.scopedPrisma]
        : [PgbaseReadService],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(PgbaseContextMiddleware).forRoutes('*');
  }
}
