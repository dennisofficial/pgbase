import type { Pool } from 'pg';
import { PgCatalogSchemaProvider } from '../../schema/resolver.js';
import type { ResolvedSchema, StaticField, StaticModel, StaticSchema } from '../../schema/types.js';
import { SCHEMA_FORMAT_VERSION } from '../../version.js';

export function model(
  partial: Partial<StaticModel> & Pick<StaticModel, 'model' | 'table'>,
): StaticModel {
  return {
    namespace: 'public',
    fields: [],
    relations: [],
    primaryKey: [],
    uniques: [],
    ...partial,
  };
}

export function field(
  name: string,
  column: string,
  overrides: Partial<StaticField> = {},
): StaticField {
  return {
    name,
    column,
    type: 'String',
    nativeType: null,
    enumName: null,
    isList: false,
    isRequired: true,
    isId: false,
    isUnique: false,
    isUpdatedAt: false,
    isForeignKey: false,
    ...overrides,
  };
}

/** REPLICA IDENTITY FULL, own PK, no composite key, no tenant weirdness. */
export const JOB_MODEL: StaticModel = model({
  model: 'Job',
  table: 'jobs',
  fields: [
    field('id', 'id', { isId: true }),
    field('orgId', 'org_id', { isForeignKey: true }),
    field('name', 'name'),
    field('status', 'status', { type: 'JobStatus', enumName: 'JobStatus' }),
    field('priority', 'priority', { type: 'Int' }),
    field('labels', 'labels', { isList: true }),
    field('metadata', 'metadata', { type: 'Json' }),
    field('closedAt', 'closed_at', { type: 'DateTime', isRequired: false }),
    field('createdAt', 'created_at', { type: 'DateTime' }),
    field('updatedAt', 'updated_at', { type: 'DateTime', isUpdatedAt: true }),
  ],
  primaryKey: ['id'],
});

/** Every-column-must-be-checked case: `webhookSecret` must never survive a correct transform. */
export const JOB_SETTINGS_MODEL: StaticModel = model({
  model: 'JobSettings',
  table: 'job_settings',
  fields: [
    field('jobId', 'job_id', { isId: true, isForeignKey: true }),
    field('concurrency', 'concurrency', { type: 'Int' }),
    field('webhookSecret', 'webhook_secret'),
  ],
  primaryKey: ['job_id'],
});

/** Composite PK, REPLICA IDENTITY FULL. */
export const MEMBERSHIP_MODEL: StaticModel = model({
  model: 'Membership',
  table: 'memberships',
  fields: [
    field('orgId', 'org_id', { isForeignKey: true }),
    field('userId', 'user_id', { isForeignKey: true }),
    field('role', 'role', { type: 'MemberRole', enumName: 'MemberRole' }),
  ],
  primaryKey: ['org_id', 'user_id'],
});

/** No tenant column, single-column PK, default (non-FULL) replica identity. */
export const AUDIT_LOG_MODEL: StaticModel = model({
  model: 'AuditLog',
  table: 'audit_log',
  fields: [
    field('id', 'id', { type: 'BigInt', isId: true }),
    field('action', 'action'),
    field('actorId', 'actor_id', { isRequired: false }),
    field('at', 'at', { type: 'DateTime' }),
  ],
  primaryKey: ['id'],
});

/** Has a real boolean column (`done`), for the co-variance path. */
export const TASK_MODEL: StaticModel = model({
  model: 'Task',
  table: 'tasks',
  fields: [
    field('id', 'id', { isId: true }),
    field('orgId', 'org_id', { isForeignKey: true }),
    field('jobId', 'job_id', { isForeignKey: true }),
    field('title', 'title'),
    field('done', 'done', { type: 'Boolean' }),
    field('blockedBy', 'blocked_by', { type: 'Json' }),
    field('createdAt', 'created_at', { type: 'DateTime' }),
  ],
  primaryKey: ['id'],
});

export const FIXTURE_MODELS: readonly StaticModel[] = [
  JOB_MODEL,
  JOB_SETTINGS_MODEL,
  MEMBERSHIP_MODEL,
  AUDIT_LOG_MODEL,
  TASK_MODEL,
];

function staticSchema(models: readonly StaticModel[]): StaticSchema {
  return { formatVersion: SCHEMA_FORMAT_VERSION, models, enums: [] };
}

export async function resolveFixtureSchema(pool: Pool): Promise<ResolvedSchema> {
  return new PgCatalogSchemaProvider(staticSchema(FIXTURE_MODELS), pool).resolve();
}

export async function resolveOne(pool: Pool, m: StaticModel): Promise<ResolvedSchema> {
  return new PgCatalogSchemaProvider(staticSchema([m]), pool).resolve();
}
