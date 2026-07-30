import type { ResultPlan } from './types.js';

export function applyPlan(plan: ResultPlan, result: unknown): unknown {
  if (result === null || result === undefined) return result;
  if (Array.isArray(result)) return result.map((row) => applyRow(plan, row));
  return applyRow(plan, result);
}

function applyRow(plan: ResultPlan, row: unknown): unknown {
  const view = plan.transform(row);
  if (view === null || typeof view !== 'object' || plan.relations.size === 0) return view;

  const raw = row as Record<string, unknown>;
  const out: Record<string, unknown> = { ...(view as Record<string, unknown>) };
  for (const [key, nestedPlan] of plan.relations) {
    if (!(key in raw)) continue;
    out[key] = applyPlan(nestedPlan, raw[key]);
  }
  return out;
}
