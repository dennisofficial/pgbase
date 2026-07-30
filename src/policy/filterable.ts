import type { LiveWhere, PredicateNode } from '../query/ast.js';
import { normalize } from '../query/normalize.js';
import type { ResolvedModel } from '../schema/types.js';
import { PolicyValidationError } from './errors.js';
import type { Policy, ProbeResult } from './types.js';

export function computeFilterable(
  model: ResolvedModel,
  policy: Policy<any, any, any>,
): ProbeResult {
  const fieldNames = new Set(model.fields.map((f) => f.name));
  const unknown = (policy.omit as readonly string[]).filter((f) => !fieldNames.has(f));
  if (unknown.length > 0) {
    throw new PolicyValidationError(
      `Model "${model.model}": "omit" names field(s) that do not exist on this model: ` +
        `${unknown.join(', ')}. A renamed or removed column left in "omit" would otherwise ` +
        `silently stop hiding anything.`,
    );
  }

  const omitted = new Set(policy.omit as readonly string[]);
  const filterable = new Set([...fieldNames].filter((f) => !omitted.has(f)));
  return { model: model.model, filterable };
}

export function normalizeClientWhere(
  where: LiveWhere,
  model: ResolvedModel,
  probeResult: ProbeResult,
): PredicateNode {
  return normalize(where, model, probeResult.filterable);
}
