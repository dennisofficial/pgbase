import { Inject, Injectable, type Provider } from '@nestjs/common';
import type { ValidatedPolicy } from '../policy/index.js';
import { validatePolicies } from '../policy/index.js';
import type { ResolvedSchema, SchemaProvider } from '../schema/index.js';
import { PgCatalogSchemaProvider } from '../schema/index.js';
import { PGBASE_OPTIONS, type Resolved } from './tokens.js';
import type { PgbaseModuleOptions } from './types.js';

export abstract class PgbaseSchemaProvider implements SchemaProvider {
  abstract resolve(): Promise<ResolvedSchema>;
}

@Injectable()
export class PgCatalogSchemaProviderService extends PgbaseSchemaProvider {
  constructor(@Inject(PGBASE_OPTIONS) private readonly options: PgbaseModuleOptions) {
    super();
  }

  resolve(): Promise<ResolvedSchema> {
    return new PgCatalogSchemaProvider(this.options.schema, this.options.pool, {
      publication: this.options.publication,
    }).resolve();
  }
}

export class PgbaseSchemaRegistry implements Resolved {
  constructor(
    readonly schema: ResolvedSchema,
    readonly policies: ReadonlyMap<string, ValidatedPolicy>,
  ) {}
}

export const schemaRegistryProvider: Provider = {
  provide: PgbaseSchemaRegistry,
  useFactory: async (
    provider: PgbaseSchemaProvider,
    options: PgbaseModuleOptions,
  ): Promise<PgbaseSchemaRegistry> => {
    const schema = await provider.resolve();
    return new PgbaseSchemaRegistry(schema, validatePolicies(schema, options.policies));
  },
  inject: [PgbaseSchemaProvider, PGBASE_OPTIONS],
};
