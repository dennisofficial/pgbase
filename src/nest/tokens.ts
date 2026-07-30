import type { ValidatedPolicy } from '../policy/index.js';
import type { ResolvedSchema } from '../schema/index.js';

export const PGBASE_OPTIONS = Symbol('PGBASE_OPTIONS');
export const PGBASE_RESOLVED = Symbol('PGBASE_RESOLVED');
export const PGBASE_CONTEXT_STORE = Symbol('PGBASE_CONTEXT_STORE');
export const PGBASE_CLAIMS_CACHE = Symbol('PGBASE_CLAIMS_CACHE');
export const PGBASE_WIRE_CODEC = Symbol('PGBASE_WIRE_CODEC');

export interface Resolved {
  readonly schema: ResolvedSchema;
  readonly policies: ReadonlyMap<string, ValidatedPolicy>;
}

export function delegateName(model: string): string {
  return model.length === 0 ? model : model[0]!.toLowerCase() + model.slice(1);
}
