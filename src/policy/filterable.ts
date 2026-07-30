import type { LiveWhere, PredicateNode } from '../query/ast.js';
import { normalize } from '../query/normalize.js';
import type { ResolvedModel } from '../schema/types.js';
import type { ProbeResult } from './types.js';

export function normalizeClientWhere(
  where: LiveWhere,
  model: ResolvedModel,
  probeResult: ProbeResult,
): PredicateNode {
  return normalize(where, model, probeResult.filterable);
}
