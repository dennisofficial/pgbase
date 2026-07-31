import { describe, expect, it } from 'vitest';
import { buildProjector } from '../../policy/project.js';
import type { Policy } from '../../policy/types.js';
import { OID } from '../../query/compare.js';
import type { ResolvedField, ResolvedModel } from '../../schema/types.js';
import { buildIdentifier, buildLiveProjector } from '../subscription.js';

function field(
  name: string,
  column: string,
  overrides: Partial<ResolvedField> = {},
): ResolvedField {
  return {
    name,
    column,
    type: 'Unknown',
    nativeType: null,
    enumName: null,
    isList: false,
    isRequired: true,
    isId: false,
    isUnique: false,
    isUpdatedAt: false,
    isForeignKey: false,
    typeOid: OID.TEXT,
    typeName: 'text',
    elementTypeOid: null,
    elementTypeName: null,
    isCitext: false,
    enumValues: null,
    ...overrides,
  };
}

// Every column is @map'd, as in examples/api (created_at -> createdAt, org_id -> orgId).
const FIELDS: readonly ResolvedField[] = [
  field('jobId', 'job_id', { typeOid: OID.INT4, isId: true }),
  field('orgId', 'org_id', { typeOid: OID.TEXT }),
  field('createdAt', 'created_at', { typeOid: OID.TEXT }),
  field('webhookSecret', 'webhook_secret', { typeOid: OID.TEXT }),
];

const MODEL = {
  model: 'Job',
  table: 'jobs',
  namespace: 'public',
  fields: FIELDS,
  byColumn: new Map(FIELDS.map((f) => [f.column, f])),
  primaryKey: ['job_id'],
} as unknown as ResolvedModel;

const policy: Policy<any, any, any> = {
  model: 'Job',
  omit: ['webhookSecret'],
  rls: () => ({}),
};

/** What the WAL hands us: column-keyed. */
const WAL_ROW = {
  job_id: 7,
  org_id: 'org-a',
  created_at: '2026-01-01',
  webhook_secret: 'do-not-leak',
};

describe('column-keyed WAL rows through a @map`ped model', () => {
  it('projects to field names, dropping omitted columns', () => {
    expect(buildLiveProjector(MODEL, policy)(WAL_ROW)).toEqual({
      jobId: 7,
      orgId: 'org-a',
      createdAt: '2026-01-01',
    });
  });

  it('an omitted column never survives the live path', () => {
    const view = buildLiveProjector(MODEL, policy)(WAL_ROW) as Record<string, unknown>;
    expect(Object.values(view)).not.toContain('do-not-leak');
    expect('webhookSecret' in view).toBe(false);
    expect('webhook_secret' in view).toBe(false);
  });

  it('identifies rows by field-named primary key', () => {
    expect(buildIdentifier(MODEL)(WAL_ROW)).toEqual({ jobId: 7 });
    // A DELETE pre-image is key-only; identify must cope with the other columns absent.
    expect(buildIdentifier(MODEL)({ job_id: 7 })).toEqual({ jobId: 7 });
  });

  it("the read path's projector cannot read a WAL row — which is why live needs its own", () => {
    // Guards the reason buildLiveProjector exists. buildProjector reads `field.name`, so against a
    // column-keyed row every lookup misses and the view comes back empty. Using it on the live
    // path would silently deliver {} for every row on any @map'ped model.
    expect(buildProjector(MODEL, policy)(WAL_ROW)).toEqual({});
  });
});
