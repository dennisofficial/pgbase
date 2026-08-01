import { describe, expect, it } from 'vitest';
import type { StaticField, StaticSchema } from '../../schema/types.js';
import { SCHEMA_FORMAT_VERSION } from '../../version.js';
import { emitModelTypesModule } from '../emit-models.js';

function field(overrides: Partial<StaticField> & Pick<StaticField, 'name' | 'type'>): StaticField {
  return {
    column: overrides.name,
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

const SCHEMA: StaticSchema = {
  formatVersion: SCHEMA_FORMAT_VERSION,
  models: [
    {
      model: 'Job',
      table: 'jobs',
      namespace: 'public',
      fields: [
        field({ name: 'id', type: 'String', isId: true }),
        field({ name: 'status', type: 'JobStatus', enumName: 'JobStatus' }),
        field({ name: 'labels', type: 'String', isList: true }),
        field({ name: 'closedAt', type: 'DateTime', isRequired: false }),
        field({ name: 'externalRef', type: 'BigInt' }),
        field({ name: 'amount', type: 'Decimal' }),
        field({ name: 'metadata', type: 'Json' }),
        field({ name: 'blob', type: 'Bytes' }),
      ],
      relations: [
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
      primaryKey: ['id'],
      uniques: [],
    },
  ],
  enums: [{ name: 'JobStatus', dbName: 'job_status', values: ['QUEUED', 'DONE'] }],
};

describe('emitModelTypesModule', () => {
  const source = emitModelTypesModule(SCHEMA);

  it('emits an enum as a string-literal union, so no runtime import is needed', () => {
    expect(source).toContain(`export type JobStatus = "QUEUED" | "DONE";`);
  });

  it('maps scalars to what the wire codec actually delivers', () => {
    expect(source).toContain('readonly id: string;');
    expect(source).toContain('readonly externalRef: bigint;');
    expect(source).toContain('readonly metadata: unknown;');
    expect(source).toContain('readonly blob: Uint8Array;');
  });

  // Decimal crosses as a string unless the server was given a decimalConstructor; typing it as
  // `Decimal` would demand a Prisma import in the browser to satisfy.
  it('types Decimal as string', () => {
    expect(source).toContain('readonly amount: string;');
  });

  it('makes an optional field nullable and a list readonly', () => {
    expect(source).toContain('readonly closedAt: Date | null;');
    expect(source).toContain('readonly labels: readonly string[];');
  });

  it('references an enum field by its emitted type', () => {
    expect(source).toContain('readonly status: JobStatus;');
  });

  // A live delta carries the row's own columns only, so a model type that promised relations
  // would be wrong for every subscription.
  it('omits relations', () => {
    expect(source).not.toContain('tasks');
  });

  it('collects the models into the map createClient expects', () => {
    expect(source).toContain('export interface PgbaseModels {');
    expect(source).toContain('readonly Job: Job;');
  });

  it('is types-only, so importing it from a bundle emits nothing', () => {
    expect(source).not.toMatch(/^(?!\/\/)(?!\s*$).*\b(const|let|var|function|class)\b/m);
  });
});
