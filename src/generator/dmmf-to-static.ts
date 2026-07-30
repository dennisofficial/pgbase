import type { DMMF } from '@prisma/generator-helper';
import type {
  SchemaEnum,
  StaticField,
  StaticModel,
  StaticRelation,
  StaticSchema,
} from '../schema/types.js';

/** Thrown for anything that would produce a `StaticSchema` unsafe for boot to consume. */
export class GeneratorValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeneratorValidationError';
  }
}

const SUPPORTED_PROVIDERS = new Set(['postgresql', 'postgres']);

export interface DmmfToStaticOptions {
  /** `datasources[0].activeProvider` from `GeneratorOptions`. */
  readonly activeProvider: string;
  readonly formatVersion: number;
}

export function dmmfToStaticSchema(
  datamodel: DMMF.Datamodel,
  options: DmmfToStaticOptions,
): StaticSchema {
  if (!SUPPORTED_PROVIDERS.has(options.activeProvider)) {
    throw new GeneratorValidationError(
      `prisma-generator-pgbase only supports the "postgresql" provider, got ` +
        `${JSON.stringify(options.activeProvider)}. pgbase reads pg_catalog at boot and has no ` +
        `path for any other database.`,
    );
  }

  const models = datamodel.models.map((model) => modelToStatic(model, datamodel));
  const enums = datamodel.enums.map(enumToStatic);

  return {
    formatVersion: options.formatVersion,
    models,
    enums,
  };
}

function enumToStatic(e: DMMF.DatamodelEnum): SchemaEnum {
  return {
    name: e.name,
    dbName: e.dbName ?? e.name,
    values: e.values.map((v) => v.name),
  };
}

function modelToStatic(model: DMMF.Model, datamodel: DMMF.Datamodel): StaticModel {
  const columnByFieldName = new Map<string, string>();
  for (const field of model.fields) {
    if (field.kind === 'scalar' || field.kind === 'enum') {
      columnByFieldName.set(field.name, field.dbName ?? field.name);
    }
  }

  // e.g. `orgId` behind `org`. No DMMF field flags this directly — it has to be derived from
  // every relation field's `relationFromFields`.
  const foreignKeyFieldNames = new Set<string>();
  for (const field of model.fields) {
    if (field.kind === 'object' && field.relationFromFields) {
      for (const fk of field.relationFromFields) foreignKeyFieldNames.add(fk);
    }
  }

  for (const field of model.fields) {
    if (field.kind === 'unsupported') {
      throw new GeneratorValidationError(
        `Model "${model.name}", field "${field.name}": Prisma's Unsupported(...) types have no ` +
          `defined physical mapping and are not handled by pgbase. Give the column a real ` +
          `Prisma scalar type or drop it from the model.`,
      );
    }
  }

  const fields: StaticField[] = model.fields
    .filter(
      (f): f is DMMF.Field & { kind: 'scalar' | 'enum' } =>
        f.kind === 'scalar' || f.kind === 'enum',
    )
    .map((field) => fieldToStatic(field, foreignKeyFieldNames));

  const relations: StaticRelation[] = model.fields
    .filter((f): f is DMMF.Field & { kind: 'object' } => f.kind === 'object')
    .map((field) => relationToStatic(model, field, datamodel));

  const primaryKey = resolvePrimaryKey(model, columnByFieldName);
  if (primaryKey.length === 0) {
    // Caught here rather than at boot so it fails on the developer's machine, not in production.
    throw new GeneratorValidationError(
      `Model "${model.name}" has no primary key. pgbase cannot track a row with no identity ` +
        `across a WAL stream — add "@id" or "@@id", or exclude the model from pgbase.`,
    );
  }

  const uniques = resolveUniques(model, columnByFieldName);

  return {
    model: model.name,
    table: model.dbName ?? model.name,
    namespace: model.schema ?? 'public',
    fields,
    relations,
    primaryKey,
    uniques,
  };
}

function resolvePrimaryKey(
  model: DMMF.Model,
  columnByFieldName: ReadonlyMap<string, string>,
): readonly string[] {
  // Composite `@@id`. Also covers the (impossible in practice, but not in the type) case of a
  // model-level `@@id` naming a single field.
  if (model.primaryKey && model.primaryKey.fields.length > 0) {
    return model.primaryKey.fields.map((fieldName) =>
      requireColumn(model, columnByFieldName, fieldName),
    );
  }
  // Field-level `@id`, including the JobSettings shape where the same field is both `@id` and
  // the local half of a `@relation`.
  const idFields = model.fields.filter((f) => f.kind !== 'object' && f.isId);
  return idFields.map((f) => requireColumn(model, columnByFieldName, f.name));
}

function requireColumn(
  model: DMMF.Model,
  columnByFieldName: ReadonlyMap<string, string>,
  fieldName: string,
): string {
  const column = columnByFieldName.get(fieldName);
  if (column === undefined) {
    throw new GeneratorValidationError(
      `Model "${model.name}": primary key names field "${fieldName}", which is not a scalar ` +
        `field on the model.`,
    );
  }
  return column;
}

function resolveUniques(
  model: DMMF.Model,
  columnByFieldName: ReadonlyMap<string, string>,
): readonly (readonly string[])[] {
  const seen = new Set<string>();
  const uniques: string[][] = [];

  const add = (fieldNames: readonly string[]) => {
    const columns = fieldNames.map((f) => requireColumn(model, columnByFieldName, f));
    const key = columns.join(' ');
    if (seen.has(key)) return;
    seen.add(key);
    uniques.push(columns);
  };

  // `@unique` on individual fields — the DMMF marks these with `isUnique`, but (depending on
  // Prisma version) does not always also list them in `uniqueFields`, so both sources are
  // consulted and de-duplicated.
  for (const field of model.fields) {
    if (field.kind !== 'object' && field.isUnique) {
      add([field.name]);
    }
  }
  // `@@unique([...])`, and single-field `@unique` on versions of the DMMF that do list it here.
  for (const fieldNames of model.uniqueFields) {
    add(fieldNames);
  }

  return uniques;
}

function fieldToStatic(
  field: DMMF.Field & { kind: 'scalar' | 'enum' },
  foreignKeyFieldNames: ReadonlySet<string>,
): StaticField {
  return {
    name: field.name,
    column: field.dbName ?? field.name,
    type: field.type,
    nativeType: field.nativeType ?? null,
    enumName: field.kind === 'enum' ? field.type : null,
    isList: field.isList,
    isRequired: field.isRequired,
    isId: field.isId,
    isUnique: field.isUnique,
    isUpdatedAt: field.isUpdatedAt ?? false,
    isForeignKey: foreignKeyFieldNames.has(field.name),
  };
}

function relationToStatic(
  model: DMMF.Model,
  field: DMMF.Field & { kind: 'object' },
  datamodel: DMMF.Datamodel,
): StaticRelation {
  const columnByFieldName = new Map<string, string>();
  for (const f of model.fields) {
    if (f.kind !== 'object') columnByFieldName.set(f.name, f.dbName ?? f.name);
  }

  const targetModel = datamodel.models.find((m) => m.name === field.type);
  if (!targetModel) {
    throw new GeneratorValidationError(
      `Model "${model.name}", relation field "${field.name}": target model ` +
        `${JSON.stringify(field.type)} was not found in the datamodel.`,
    );
  }
  const targetColumnByFieldName = new Map<string, string>();
  for (const f of targetModel.fields) {
    if (f.kind !== 'object') targetColumnByFieldName.set(f.name, f.dbName ?? f.name);
  }

  const fromColumns = (field.relationFromFields ?? []).map((f) =>
    requireColumn(model, columnByFieldName, f),
  );
  const toColumns = (field.relationToFields ?? []).map((f) =>
    requireColumn(targetModel, targetColumnByFieldName, f),
  );

  return {
    name: field.name,
    relationName: field.relationName ?? `${model.name}To${field.type}`,
    targetModel: field.type,
    cardinality: field.isList ? 'many' : 'one',
    fromColumns,
    toColumns,
    isImplicitManyToMany: isImplicitManyToMany(model, field, targetModel),
  };
}

/**
 * Prisma omits the implicit m2m join table from the DMMF entirely, so this is inferred
 * structurally: both sides are list relations, and neither side owns FK columns. An explicit
 * join model (e.g. JobWatcher) always has `relationFromFields` populated on both of its own two
 * relation fields, so it never matches this shape.
 */
function isImplicitManyToMany(
  model: DMMF.Model,
  field: DMMF.Field & { kind: 'object' },
  targetModel: DMMF.Model,
): boolean {
  if (!field.isList) return false;
  if (field.relationFromFields && field.relationFromFields.length > 0) return false;
  if (field.relationToFields && field.relationToFields.length > 0) return false;

  const inverse = targetModel.fields.find(
    (f) => f.kind === 'object' && f.relationName === field.relationName && f.type === model.name,
  );
  if (!inverse || inverse.kind !== 'object') return false;
  if (!inverse.isList) return false;
  if (inverse.relationFromFields && inverse.relationFromFields.length > 0) return false;
  if (inverse.relationToFields && inverse.relationToFields.length > 0) return false;

  return true;
}
