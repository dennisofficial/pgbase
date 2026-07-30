import type { ResolvedModel } from '../schema/types.js';
import type { Policy } from './types.js';

export function buildProjector(
  model: ResolvedModel,
  policy: Policy<any, any, any>,
): (row: unknown) => unknown {
  const omitted = new Set(policy.omit as readonly string[]);
  const visible = model.fields.filter((f) => !omitted.has(f.name));

  return (row: unknown): unknown => {
    if (row === null || typeof row !== 'object') return row;
    const raw = row as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const field of visible) {
      if (field.name in raw) out[field.name] = raw[field.name];
    }
    return out;
  };
}
