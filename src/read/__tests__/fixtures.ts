import type { Pool } from 'pg';
import {
  JOB_MODEL,
  JOB_SETTINGS_MODEL,
  TASK_MODEL,
  field,
  model,
} from '../../policy/__tests__/fixtures.js';
import { PgCatalogSchemaProvider } from '../../schema/resolver.js';
import type { ResolvedSchema, StaticModel } from '../../schema/types.js';
import { SCHEMA_FORMAT_VERSION } from '../../version.js';

/** Root of the 3-level Org → Job → Task chain used across scope.ts tests. */
export const ORG_MODEL: StaticModel = model({
  model: 'Org',
  table: 'orgs',
  fields: [
    field('id', 'id', { isId: true }),
    field('name', 'name'),
    field('slug', 'slug'),
    field('createdAt', 'created_at', { type: 'DateTime' }),
    field('updatedAt', 'updated_at', { type: 'DateTime', isUpdatedAt: true }),
  ],
  primaryKey: ['id'],
  relations: [
    {
      name: 'jobs',
      relationName: 'JobToOrg',
      targetModel: 'Job',
      cardinality: 'many',
      fromColumns: ['id'],
      toColumns: ['org_id'],
      isImplicitManyToMany: false,
    },
  ],
});

export const JOB_WITH_RELATIONS_MODEL: StaticModel = {
  ...JOB_MODEL,
  relations: [
    {
      name: 'org',
      relationName: 'JobToOrg',
      targetModel: 'Org',
      cardinality: 'one',
      fromColumns: ['org_id'],
      toColumns: ['id'],
      isImplicitManyToMany: false,
    },
    {
      name: 'settings',
      relationName: 'JobToJobSettings',
      targetModel: 'JobSettings',
      cardinality: 'one',
      fromColumns: ['id'],
      toColumns: ['job_id'],
      isImplicitManyToMany: false,
    },
    {
      name: 'tasks',
      relationName: 'JobToTask',
      targetModel: 'Task',
      cardinality: 'many',
      fromColumns: ['id'],
      toColumns: ['job_id'],
      isImplicitManyToMany: false,
    },
  ],
};

export const JOB_SETTINGS_WITH_RELATIONS_MODEL: StaticModel = {
  ...JOB_SETTINGS_MODEL,
  relations: [
    {
      name: 'job',
      relationName: 'JobToJobSettings',
      targetModel: 'Job',
      cardinality: 'one',
      fromColumns: ['job_id'],
      toColumns: ['id'],
      isImplicitManyToMany: false,
    },
  ],
};

export const TASK_WITH_RELATIONS_MODEL: StaticModel = {
  ...TASK_MODEL,
  relations: [
    {
      name: 'job',
      relationName: 'JobToTask',
      targetModel: 'Job',
      cardinality: 'one',
      fromColumns: ['job_id'],
      toColumns: ['id'],
      isImplicitManyToMany: false,
    },
  ],
};

export const READ_FIXTURE_MODELS: readonly StaticModel[] = [
  ORG_MODEL,
  JOB_WITH_RELATIONS_MODEL,
  JOB_SETTINGS_WITH_RELATIONS_MODEL,
  TASK_WITH_RELATIONS_MODEL,
];

export async function resolveReadFixtureSchema(pool: Pool): Promise<ResolvedSchema> {
  return new PgCatalogSchemaProvider(
    { formatVersion: SCHEMA_FORMAT_VERSION, models: READ_FIXTURE_MODELS, enums: [] },
    pool,
  ).resolve();
}
