import { Inject, Injectable, type Provider } from '@nestjs/common';
import { AsyncLocalStorageContextStore } from '../context/index.js';
import type { PolicyEntry, ViewOf } from '../policy/index.js';
import { DEFAULT_READ_LIMITS } from '../read/index.js';
import { PgbaseSchemaRegistry } from './schema-registry.js';
import { createScopedClient } from './scoped-extension.js';
import { PGBASE_OPTIONS } from './tokens.js';
import type { PgbaseModuleOptions, PgbasePrismaClient } from './types.js';

type FindManyDelegate = { findMany(args?: any): Promise<any> };

type ScopedModelKeys<Client, Registry> = {
  [K in Extract<keyof Client, string>]: Client[K] extends FindManyDelegate
    ? Capitalize<K> extends keyof Registry
      ? ViewOf<Registry[Capitalize<K> & keyof Registry]> extends never
        ? never
        : K
      : never
    : never;
}[Extract<keyof Client, string>];

type ScopedOperation =
  | 'findMany'
  | 'findFirst'
  | 'findFirstOrThrow'
  | 'findUnique'
  | 'findUniqueOrThrow'
  | 'count'
  | 'aggregate'
  | 'groupBy'
  | 'create'
  | 'update'
  | 'delete';

export type ScopedPrisma<Client, Registry> = {
  readonly [K in ScopedModelKeys<Client, Registry>]: Pick<
    Client[K],
    Extract<ScopedOperation, keyof Client[K]>
  >;
};

export type ScopedPrismaService<
  Client extends PgbasePrismaClient = PgbasePrismaClient,
  Registry extends Record<string, PolicyEntry<any, any, any>> = Record<
    string,
    PolicyEntry<any, any, any>
  >,
> = ScopedPrisma<Client, Registry>;

export type ScopedPrismaTokenClass<
  Client extends PgbasePrismaClient,
  Registry extends Record<string, PolicyEntry<any, any, any>>,
> = new (...args: any[]) => ScopedPrismaService<Client, Registry>;

export function ScopedPrismaToken<
  Client extends PgbasePrismaClient,
  Registry extends Record<string, PolicyEntry<any, any, any>>,
>(): ScopedPrismaTokenClass<Client, Registry> {
  return class ScopedPrismaToken {} as unknown as ScopedPrismaTokenClass<Client, Registry>;
}

@Injectable()
class ScopedPrismaFactory {
  constructor(
    @Inject(PGBASE_OPTIONS) private readonly options: PgbaseModuleOptions,
    private readonly resolved: PgbaseSchemaRegistry,
    private readonly contextStore: AsyncLocalStorageContextStore,
  ) {}

  /** One instance for the whole process — per-request clients would multiply connection pools. */
  create<
    Client extends PgbasePrismaClient,
    Registry extends Record<string, PolicyEntry<any, any, any>>,
  >(): ScopedPrismaService<Client, Registry> {
    return createScopedClient({
      base: this.options.prisma,
      resolved: this.resolved,
      contextStore: this.contextStore,
      limits: this.options.limits ?? DEFAULT_READ_LIMITS,
    }) as ScopedPrismaService<Client, Registry>;
  }
}

export function createScopedPrismaProvider<
  Client extends PgbasePrismaClient,
  Registry extends Record<string, PolicyEntry<any, any, any>>,
>(token: ScopedPrismaTokenClass<Client, Registry>): Provider {
  return {
    provide: token,
    useFactory: (factory: ScopedPrismaFactory): ScopedPrismaService<Client, Registry> =>
      factory.create<Client, Registry>(),
    inject: [ScopedPrismaFactory],
  };
}

export { ScopedPrismaFactory };
