import type { ResolvedModel, ResolvedSchema } from '../schema/types.js';
import { PolicyValidationError } from './errors.js';
import { computeFilterable } from './filterable.js';
import { NO_CLIENT_ACCESS, type Policy, type PolicyEntry, type ProbeResult } from './types.js';

export interface ValidatedPolicy {
  readonly policy: Policy<any, any, any>;
  readonly probeResult: ProbeResult;
}

export function validatePolicies(
  schema: ResolvedSchema,
  registry: Readonly<Record<string, PolicyEntry<any, any, any>>>,
): ReadonlyMap<string, ValidatedPolicy> {
  const modelNames = new Set(schema.models.map((m) => m.model));
  const registryNames = new Set(Object.keys(registry));

  const missing = [...modelNames].filter((m) => !registryNames.has(m)).sort();
  if (missing.length > 0) {
    throw new PolicyValidationError(
      `No policy registered for model(s): ${missing.join(', ')}. Every model in the schema needs ` +
        `a registry entry — a Policy, or NO_CLIENT_ACCESS to deliberately opt out.`,
    );
  }
  const unknown = [...registryNames].filter((m) => !modelNames.has(m)).sort();
  if (unknown.length > 0) {
    throw new PolicyValidationError(
      `Policy registry names model(s) not present in the schema: ${unknown.join(', ')}. Likely a ` +
        `typo, or a model that was renamed or removed without updating the registry.`,
    );
  }

  const result = new Map<string, ValidatedPolicy>();

  for (const model of schema.models) {
    const entry = registry[model.model]!;
    if (entry === NO_CLIENT_ACCESS) continue;

    const policy = entry;
    const probeResult = computeFilterable(model, policy);

    if (probeResult.filterable.size === 0) {
      throw new PolicyValidationError(
        `Model "${model.model}": "omit" hides every column on this model — nothing is exposed. ` +
          `Almost certainly a mistake; NO_CLIENT_ACCESS says the same thing without a policy.`,
      );
    }

    checkReplicaIdentity(model, probeResult);

    result.set(model.model, { policy, probeResult });
  }

  return result;
}

/** Types large enough to be stored out-of-line, where an UPDATE can omit the value entirely. */
const TOASTABLE_TYPE_OIDS = new Set([
  17, // bytea
  25, // text
  114, // json
  1042, // bpchar
  1043, // varchar
  3802, // jsonb
]);

function checkReplicaIdentity(model: ResolvedModel, probeResult: ProbeResult): void {
  if (model.replicaIdentity === 'full') return;

  const pkFieldNames = new Set(
    model.primaryKey
      .map((column) => model.byColumn.get(column)?.name)
      .filter((n): n is string => n !== undefined),
  );
  const toastable = [...probeResult.filterable]
    .filter((name) => !pkFieldNames.has(name))
    .filter((name) => {
      const field = model.fields.find((f) => f.name === name);
      return (
        field !== undefined &&
        (TOASTABLE_TYPE_OIDS.has(field.typeOid) || field.elementTypeOid !== null)
      );
    })
    .sort();
  if (toastable.length === 0) return;

  console.warn(
    `[pgbase] Model "${model.model}" allows filtering on potentially large column(s) ` +
      `${toastable.join(', ')} and the table is not REPLICA IDENTITY FULL. An UPDATE that does ` +
      `not touch such a column omits its value from the WAL, leaving live subscriptions unable to ` +
      `evaluate the predicate — they will resync instead. If that table is updated often, either ` +
      `run ALTER TABLE "${model.table}" REPLICA IDENTITY FULL or omit those columns from the policy.`,
  );
}
