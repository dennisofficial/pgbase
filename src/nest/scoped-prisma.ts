import { Inject, Injectable, type Provider } from '@nestjs/common';
import type { ContextStore } from '../context/index.js';
import type { PolicyEntry, ViewOf } from '../policy/index.js';
import type { ReadArgs } from '../read/index.js';
import { PgbaseReadService } from './read-service.js';
import type { Resolved } from './tokens.js';
import { PGBASE_CONTEXT_STORE, PGBASE_OPTIONS, PGBASE_RESOLVED, delegateName } from './tokens.js';
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

export type ScopedPrisma<Client, Registry> = {
  readonly [K in ScopedModelKeys<Client, Registry>]: {
    findMany(
      args?: Client[K] extends { findMany(args?: infer A): any } ? A : never,
    ): Promise<ViewOf<Registry[Capitalize<K & string> & keyof Registry]>[]>;
  };
};

export type ScopedPrismaService<
  Client extends PgbasePrismaClient = PgbasePrismaClient,
  Registry extends Record<string, PolicyEntry<any, any, any>> = Record<
    string,
    PolicyEntry<any, any, any>
  >,
> = ScopedPrisma<Client, Registry> & {
  /** Escape hatch for genuinely unscoped server work — bypasses RLS/policy scoping entirely. */
  runUnscoped<T>(reason: string, fn: (prisma: Client) => Promise<T>): Promise<T>;
};

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
    private readonly reads: PgbaseReadService,
    @Inject(PGBASE_RESOLVED) private readonly resolved: Resolved,
    @Inject(PGBASE_OPTIONS) private readonly options: PgbaseModuleOptions,
    @Inject(PGBASE_CONTEXT_STORE) private readonly contextStore: ContextStore,
  ) {}

  create<
    Client extends PgbasePrismaClient,
    Registry extends Record<string, PolicyEntry<any, any, any>>,
  >(): ScopedPrismaService<Client, Registry> {
    const modelByDelegate = new Map(
      this.resolved.schema.models.map((m) => [delegateName(m.model), m.model] as const),
    );

    const base = {
      runUnscoped: <T>(reason: string, fn: (prisma: PgbasePrismaClient) => Promise<T>) =>
        this.contextStore.runUnscoped(reason, () => fn(this.options.prisma)),
    };

    // A Proxy can never be statically shown to carry the mapped delegates; this is the one cast,
    // and `createScopedPrismaProvider` checks it against the token's declared instance type.
    return new Proxy(base, {
      get: (target, prop, receiver) => {
        if (typeof prop === 'string' && prop in target) return Reflect.get(target, prop, receiver);
        if (typeof prop !== 'string') return undefined;
        const model = modelByDelegate.get(prop);
        if (!model) return undefined;
        return { findMany: (args: ReadArgs = {}) => this.reads.read(model, args) };
      },
    }) as unknown as ScopedPrismaService<Client, Registry>;
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
