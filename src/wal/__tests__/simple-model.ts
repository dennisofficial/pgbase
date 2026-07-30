import type { Pool } from 'pg';
import { PgCatalogSchemaProvider } from '../../schema/resolver.js';
import type {
  ResolvedModel,
  ResolvedSchema,
  SchemaEnum,
  StaticField,
  StaticSchema,
} from '../../schema/types.js';
import { SCHEMA_FORMAT_VERSION } from '../../version.js';

export interface SimpleColumn {
  readonly name: string;
  readonly required?: boolean;
  readonly enumName?: string;
  readonly isList?: boolean;
}

export async function resolveSimpleModel(
  pool: Pool,
  modelName: string,
  table: string,
  columns: readonly SimpleColumn[],
  options: { readonly primaryKey?: readonly string[]; readonly enums?: readonly SchemaEnum[] } = {},
): Promise<ResolvedModel> {
  const fields: StaticField[] = columns.map((c) => ({
    name: c.name,
    column: c.name,
    type: 'Unknown',
    nativeType: null,
    enumName: c.enumName ?? null,
    isList: c.isList ?? false,
    isRequired: c.required ?? false,
    isId: c.name === (options.primaryKey?.[0] ?? 'id'),
    isUnique: false,
    isUpdatedAt: false,
    isForeignKey: false,
  }));
  const staticSchema: StaticSchema = {
    formatVersion: SCHEMA_FORMAT_VERSION,
    enums: options.enums ?? [],
    models: [
      {
        model: modelName,
        table,
        namespace: 'public',
        fields,
        relations: [],
        primaryKey: options.primaryKey ?? ['id'],
        uniques: [],
      },
    ],
  };
  const resolved = await new PgCatalogSchemaProvider(staticSchema, pool).resolve();
  return resolved.byModel.get(modelName)!;
}

export function schemaOf(
  model: ResolvedModel,
  publication: string,
  enums: readonly SchemaEnum[] = [],
): ResolvedSchema {
  return {
    formatVersion: SCHEMA_FORMAT_VERSION,
    publication,
    models: [model],
    enums,
    byModel: new Map([[model.model, model]]),
    byTable: new Map([[`${model.namespace}.${model.table}`, model]]),
  };
}
