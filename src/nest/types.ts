import type { FactoryProvider, ModuleMetadata } from '@nestjs/common';
import type { Pool } from 'pg';
import type { ClaimsBuilder, MemoryClaimsCacheOptions } from '../context/index.js';
import type { PolicyEntry } from '../policy/index.js';
import type { ArgsTreeLimits, ReadLimits, WireCustomType } from '../read/index.js';
import type { StaticSchema } from '../schema/index.js';
import type { ScopedPrismaTokenClass } from './scoped-prisma.js';

/** Minimal shape pgbase needs from a generated Prisma client — never the full generated type. */
export interface PgbasePrismaClient {
  $transaction<T>(fn: (tx: PgbasePrismaClient) => Promise<T>): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
  [model: string]: any;
}

export interface PgbaseModuleOptions<
  Principal = unknown,
  Claims = unknown,
  Client extends PgbasePrismaClient = PgbasePrismaClient,
  Registry extends Record<string, PolicyEntry<any, any, any>> = Record<
    string,
    PolicyEntry<any, any, any>
  >,
> {
  readonly pool: Pool;
  readonly prisma: Client;
  readonly schema: StaticSchema;
  readonly policies: Readonly<Registry>;
  readonly claimsBuilder: ClaimsBuilder<Principal, Claims>;
  readonly claimsCacheOptions?: MemoryClaimsCacheOptions;
  readonly limits?: ReadLimits;
  readonly argsLimits?: ArgsTreeLimits;
  readonly serializers?: readonly WireCustomType[];
  readonly decimalConstructor?: (value: string) => unknown;
  readonly publication?: string;
  readonly scopedPrisma?: ScopedPrismaTokenClass<Client, Registry>;
  readonly routePrefix?: string;
  readonly getPrincipal: (req: unknown) => Principal;
}

export type PgbaseRuntimeOptions<
  Principal = unknown,
  Claims = unknown,
  Client extends PgbasePrismaClient = PgbasePrismaClient,
  Registry extends Record<string, PolicyEntry<any, any, any>> = Record<
    string,
    PolicyEntry<any, any, any>
  >,
> = Omit<PgbaseModuleOptions<Principal, Claims, Client, Registry>, 'scopedPrisma' | 'routePrefix'>;

export interface PgbaseModuleAsyncOptions<
  Principal = unknown,
  Claims = unknown,
  Client extends PgbasePrismaClient = PgbasePrismaClient,
  Registry extends Record<string, PolicyEntry<any, any, any>> = Record<
    string,
    PolicyEntry<any, any, any>
  >,
> {
  readonly imports?: ModuleMetadata['imports'];
  readonly inject?: FactoryProvider['inject'];
  readonly useFactory: (
    ...args: any[]
  ) =>
    | PgbaseRuntimeOptions<Principal, Claims, Client, Registry>
    | Promise<PgbaseRuntimeOptions<Principal, Claims, Client, Registry>>;
  readonly scopedPrisma?: ScopedPrismaTokenClass<Client, Registry>;
  readonly routePrefix?: string;
}
