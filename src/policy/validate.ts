import type { ResolvedModel, ResolvedSchema } from '../schema/types.js';
import { PolicyValidationError } from './errors.js';
import { probe as defaultProbe } from './sentinel.js';
import { NO_CLIENT_ACCESS, type Policy, type PolicyEntry, type ProbeResult } from './types.js';

export interface ValidatedPolicy {
  readonly policy: Policy;
  readonly probeResult: ProbeResult;
}

export interface ValidatePoliciesOptions {
  readonly probe?: (model: ResolvedModel, transform: (row: never) => unknown) => ProbeResult;
}

export function validatePolicies(
  schema: ResolvedSchema,
  registry: Readonly<Record<string, PolicyEntry<any, any, any>>>,
  options: ValidatePoliciesOptions = {},
): ReadonlyMap<string, ValidatedPolicy> {
  const probeFn = options.probe ?? defaultProbe;

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
    const probeResult = probeFn(model, policy.transform as (row: never) => unknown);

    const anyExposed = [...probeResult.exposure.values()].some((e) => e !== 'absent');
    if (!anyExposed) {
      throw new PolicyValidationError(
        `Model "${model.model}": transform's output exposes no columns at all — every column ` +
          `probed "absent". Almost certainly a mistake: either the transform returns an empty ` +
          `object, or it never reads any column off its own row.`,
      );
    }

    checkReplicaIdentity(model, probeResult);

    result.set(model.model, { policy, probeResult });
  }

  return result;
}

function checkReplicaIdentity(model: ResolvedModel, probeResult: ProbeResult): void {
  if (model.replicaIdentity === 'full') return;

  const pkFieldNames = new Set(
    model.primaryKey
      .map((column) => model.byColumn.get(column)?.name)
      .filter((n): n is string => n !== undefined),
  );
  const offending = [...probeResult.filterable].filter((name) => !pkFieldNames.has(name)).sort();
  if (offending.length === 0) return;

  throw new PolicyValidationError(
    `Model "${model.model}" is filterable on column(s) ${offending.join(', ')}, which are not ` +
      `part of its primary key, but the table is not REPLICA IDENTITY FULL. Without FULL, an ` +
      `UPDATE's old tuple carries only the key, so the leader cannot tell whether a row left a ` +
      `subscription's filter — the row would go stale on clients instead of being removed. Run ` +
      `ALTER TABLE ... REPLICA IDENTITY FULL, or narrow the transform so it exposes only ` +
      `primary-key columns.`,
  );
}
