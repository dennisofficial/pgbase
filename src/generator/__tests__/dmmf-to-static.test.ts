/**
 * Pure unit tests for the DMMF → `StaticSchema` mapping — no database, no Prisma generator RPC.
 * Fixture shapes mirror what a real `getDMMF()` call produces, verified empirically against the
 * example app's Prisma schema rather than hand-guessed.
 */
import type { DMMF } from '@prisma/generator-helper';
import { describe, expect, it } from 'vitest';
import { dmmfToStaticSchema, GeneratorValidationError } from '../dmmf-to-static.js';

function datamodel(models: DMMF.Model[], enums: DMMF.DatamodelEnum[] = []): DMMF.Datamodel {
  return { models, enums, types: [], indexes: [] };
}

function scalarField(overrides: Partial<DMMF.Field> & { name: string }): DMMF.Field {
  return {
    kind: 'scalar',
    isRequired: true,
    isList: false,
    isUnique: false,
    isId: false,
    isReadOnly: false,
    type: 'String',
    hasDefaultValue: false,
    ...overrides,
  };
}

function relationField(overrides: Partial<DMMF.Field> & { name: string; type: string }): DMMF.Field {
  return {
    kind: 'object',
    isRequired: true,
    isList: false,
    isUnique: false,
    isId: false,
    isReadOnly: false,
    hasDefaultValue: false,
    ...overrides,
  };
}

const OPTS = { activeProvider: 'postgresql', formatVersion: 1 };

describe('dmmfToStaticSchema — primary keys', () => {
  it('maps a composite @@id to column names in declared order', () => {
    const model: DMMF.Model = {
      name: 'Membership',
      dbName: 'memberships',
      schema: null,
      fields: [
        scalarField({ name: 'orgId', dbName: 'org_id' }),
        scalarField({ name: 'userId', dbName: 'user_id' }),
      ],
      uniqueFields: [],
      uniqueIndexes: [],
      primaryKey: { name: null, fields: ['orgId', 'userId'] },
    };

    const result = dmmfToStaticSchema(datamodel([model]), OPTS);
    expect(result.models[0]!.primaryKey).toEqual(['org_id', 'user_id']);
  });

  it('marks a single @id field that is also the local half of a @relation (PK-is-FK)', () => {
    const jobSettings: DMMF.Model = {
      name: 'JobSettings',
      dbName: 'job_settings',
      schema: null,
      fields: [
        scalarField({ name: 'jobId', dbName: 'job_id', isId: true }),
        relationField({
          name: 'job',
          type: 'Job',
          relationName: 'JobToJobSettings',
          relationFromFields: ['jobId'],
          relationToFields: ['id'],
        }),
      ],
      uniqueFields: [],
      uniqueIndexes: [],
      primaryKey: null,
    };
    const job: DMMF.Model = {
      name: 'Job',
      dbName: 'jobs',
      schema: null,
      fields: [scalarField({ name: 'id', isId: true })],
      uniqueFields: [],
      uniqueIndexes: [],
      primaryKey: null,
    };

    const result = dmmfToStaticSchema(datamodel([jobSettings, job]), OPTS);
    const jobSettingsResult = result.models.find((m) => m.model === 'JobSettings')!;
    expect(jobSettingsResult.primaryKey).toEqual(['job_id']);
    const jobId = jobSettingsResult.fields.find((f) => f.name === 'jobId')!;
    expect(jobId.isId).toBe(true);
    expect(jobId.isForeignKey).toBe(true);
  });

  it('throws, naming the model, when there is no primary key at all', () => {
    const model: DMMF.Model = {
      name: 'NoPk',
      dbName: null,
      schema: null,
      fields: [scalarField({ name: 'value' })],
      uniqueFields: [],
      uniqueIndexes: [],
      primaryKey: null,
    };

    expect(() => dmmfToStaticSchema(datamodel([model]), OPTS)).toThrow(GeneratorValidationError);
    expect(() => dmmfToStaticSchema(datamodel([model]), OPTS)).toThrow(/NoPk/);
  });
});

describe('dmmfToStaticSchema — implicit many-to-many detection', () => {
  it('flags both sides of a genuine implicit m2m (Job <-> Tag)', () => {
    const job: DMMF.Model = {
      name: 'Job',
      dbName: 'jobs',
      schema: null,
      fields: [
        scalarField({ name: 'id', isId: true }),
        relationField({
          name: 'tags',
          type: 'Tag',
          isList: true,
          relationName: 'JobToTag',
          relationFromFields: [],
          relationToFields: [],
        }),
      ],
      uniqueFields: [],
      uniqueIndexes: [],
      primaryKey: null,
    };
    const tag: DMMF.Model = {
      name: 'Tag',
      dbName: 'tags',
      schema: null,
      fields: [
        scalarField({ name: 'id', isId: true }),
        relationField({
          name: 'jobs',
          type: 'Job',
          isList: true,
          relationName: 'JobToTag',
          relationFromFields: [],
          relationToFields: [],
        }),
      ],
      uniqueFields: [],
      uniqueIndexes: [],
      primaryKey: null,
    };

    const result = dmmfToStaticSchema(datamodel([job, tag]), OPTS);
    const jobModel = result.models.find((m) => m.model === 'Job')!;
    const tagModel = result.models.find((m) => m.model === 'Tag')!;
    expect(jobModel.relations.find((r) => r.name === 'tags')!.isImplicitManyToMany).toBe(true);
    expect(tagModel.relations.find((r) => r.name === 'jobs')!.isImplicitManyToMany).toBe(true);
  });

  it('does NOT flag an explicit join model (Job <-> JobWatcher)', () => {
    const job: DMMF.Model = {
      name: 'Job',
      dbName: 'jobs',
      schema: null,
      fields: [
        scalarField({ name: 'id', isId: true }),
        relationField({
          name: 'watchers',
          type: 'JobWatcher',
          isList: true,
          relationName: 'JobToJobWatcher',
          relationFromFields: [],
          relationToFields: [],
        }),
      ],
      uniqueFields: [],
      uniqueIndexes: [],
      primaryKey: null,
    };
    const jobWatcher: DMMF.Model = {
      name: 'JobWatcher',
      dbName: 'job_watchers',
      schema: null,
      fields: [
        scalarField({ name: 'jobId', dbName: 'job_id' }),
        scalarField({ name: 'userId', dbName: 'user_id' }),
        relationField({
          name: 'job',
          type: 'Job',
          relationName: 'JobToJobWatcher',
          relationFromFields: ['jobId'],
          relationToFields: ['id'],
        }),
      ],
      uniqueFields: [],
      uniqueIndexes: [],
      primaryKey: { name: null, fields: ['jobId', 'userId'] },
    };

    const result = dmmfToStaticSchema(datamodel([job, jobWatcher]), OPTS);
    const jobModel = result.models.find((m) => m.model === 'Job')!;
    expect(jobModel.relations.find((r) => r.name === 'watchers')!.isImplicitManyToMany).toBe(
      false,
    );
  });
});

describe('dmmfToStaticSchema — misc', () => {
  it('rejects a non-postgresql provider loudly', () => {
    expect(() =>
      dmmfToStaticSchema(datamodel([]), { ...OPTS, activeProvider: 'mysql' }),
    ).toThrow(/postgresql/);
  });

  it('de-duplicates a field carrying both isUnique and a matching @@unique entry', () => {
    const model: DMMF.Model = {
      name: 'Tag',
      dbName: 'tags',
      schema: null,
      fields: [
        scalarField({ name: 'id', isId: true }),
        scalarField({ name: 'name', isUnique: true }),
      ],
      uniqueFields: [['name']],
      uniqueIndexes: [{ name: 'tags_name_key', fields: ['name'] }],
      primaryKey: null,
    };

    const result = dmmfToStaticSchema(datamodel([model]), OPTS);
    expect(result.models[0]!.uniques).toEqual([['name']]);
  });

  it('reads nativeType through verbatim, e.g. Timestamptz(6)', () => {
    const model: DMMF.Model = {
      name: 'Job',
      dbName: 'jobs',
      schema: null,
      fields: [
        scalarField({ name: 'id', isId: true }),
        scalarField({
          name: 'createdAt',
          dbName: 'created_at',
          type: 'DateTime',
          nativeType: ['Timestamptz', ['6']],
        }),
      ],
      uniqueFields: [],
      uniqueIndexes: [],
      primaryKey: null,
    };

    const result = dmmfToStaticSchema(datamodel([model]), OPTS);
    const createdAt = result.models[0]!.fields.find((f) => f.name === 'createdAt')!;
    expect(createdAt.nativeType).toEqual(['Timestamptz', ['6']]);
    expect(createdAt.column).toBe('created_at');
  });
});
