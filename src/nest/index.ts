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
import { PgbaseContextMiddleware } from './context-middleware.js';
import { PgbaseExceptionFilter } from './exception-filter.js';
import { PgbaseLiveGateway } from './live-gateway.js';
import { createPgbaseReadController } from './read-controller.js';
import { PgbaseReadService } from './read-service.js';
import {
  PgCatalogSchemaProviderService,
  PgbaseSchemaProvider,
  PgbaseSchemaRegistry,
  schemaRegistryProvider,
} from './schema-registry.js';
import { ScopedPrismaFactory, createScopedPrismaProvider } from './scoped-prisma.js';
import { PGBASE_OPTIONS } from './tokens.js';
import type { PgbaseModuleAsyncOptions, PgbaseModuleOptions, PgbasePrismaClient } from './types.js';
import { PgbaseWireCodecService } from './wire-codec.js';
export { AsyncLocalStorageContextStore, MemoryClaimsCache } from '../context/index.js';
export { PgbaseWireCodec } from '../read/index.js';
export { PgbaseContextMiddleware } from './context-middleware.js';
export { PgbaseExceptionFilter } from './exception-filter.js';
export { PgbaseLiveGateway } from './live-gateway.js';
export { PgbaseLiveRuntime } from './live-runtime.js';
export type { LiveWalOptions, PgbaseLiveRuntimeOptions } from './live-runtime.js';
export { PgbaseReadService } from './read-service.js';
export {
  PgCatalogSchemaProviderService,
  PgbaseSchemaProvider,
  PgbaseSchemaRegistry,
} from './schema-registry.js';
export { ScopedRowNotFoundError } from './scoped-errors.js';
export { ScopedPrismaToken } from './scoped-prisma.js';
export type { ScopedPrisma, ScopedPrismaService, ScopedPrismaTokenClass } from './scoped-prisma.js';
export type {
  PgbaseLiveOptions,
  PgbaseModuleAsyncOptions,
  PgbaseModuleOptions,
  PgbasePrismaClient,
  PgbaseRuntimeOptions,
} from './types.js';
export { PgbaseWireCodecService } from './wire-codec.js';

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
      schemaProvider: options.schemaProvider,
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
          provide: PgbaseSchemaProvider,
          useClass: options.schemaProvider ?? PgCatalogSchemaProviderService,
        },
        schemaRegistryProvider,
        AsyncLocalStorageContextStore,
        MemoryClaimsCache,
        PgbaseWireCodecService,
        PgbaseContextMiddleware,
        PgbaseReadService,
        PgbaseLiveGateway,
        ...scoped,
        { provide: APP_FILTER, useClass: PgbaseExceptionFilter },
      ],
      exports: [
        PgbaseReadService,
        PgbaseSchemaRegistry,
        AsyncLocalStorageContextStore,
        MemoryClaimsCache,
        ...(options.scopedPrisma ? [options.scopedPrisma] : []),
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(PgbaseContextMiddleware).forRoutes('*');
  }
}
