import type { Policy } from '../../policy/types.js';
import type { LiveWhere, PredicateNode } from '../../query/ast.js';
import { referencedColumns } from '../../query/columns.js';
import { OID } from '../../query/compare.js';
import { normalize } from '../../query/normalize.js';
import type { ResolvedField, ResolvedModel } from '../../schema/types.js';
import type { ColumnRow } from '../../wal/types.js';
import { buildIdentifier, buildLiveProjector } from '../subscription.js';
import type { Subscription } from '../types.js';

function field(name: string, overrides: Partial<ResolvedField> = {}): ResolvedField {
  return {
    name,
    column: name,
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

const WIDGET_FIELDS: readonly ResolvedField[] = [
  field('id', { typeOid: OID.INT4, isId: true }),
  field('tenant', { typeOid: OID.TEXT }),
  field('score', { typeOid: OID.INT4 }),
  field('secret', { typeOid: OID.TEXT }),
];

export const WIDGET_MODEL = {
  model: 'Widget',
  table: 'widgets',
  namespace: 'public',
  fields: WIDGET_FIELDS,
  byColumn: new Map(WIDGET_FIELDS.map((f) => [f.column, f])),
  primaryKey: ['id'],
} as unknown as ResolvedModel;

const ALL_FIELD_NAMES = new Set(WIDGET_FIELDS.map((f) => f.name));

export function widgetPredicate(where: LiveWhere): PredicateNode {
  return normalize(where, WIDGET_MODEL, ALL_FIELD_NAMES);
}

export const widgetPolicy: Policy<any, any, any> = {
  model: 'Widget',
  omit: ['secret'],
  rls: () => ({}),
};

const projectWidget = buildLiveProjector(WIDGET_MODEL, widgetPolicy);
const identifyWidget = buildIdentifier(WIDGET_MODEL);

export function widgetSubscription(
  id: string,
  where: LiveWhere,
  project: (row: ColumnRow) => unknown = projectWidget,
): Subscription {
  const predicate = widgetPredicate(where);
  return {
    id,
    model: 'Widget',
    predicate,
    predicateColumns: referencedColumns(predicate),
    project,
    identify: identifyWidget,
  };
}
