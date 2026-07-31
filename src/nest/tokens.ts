import type { ValidatedPolicy } from '../policy/index.js';
import type { ResolvedSchema } from '../schema/index.js';

export const PGBASE_OPTIONS = Symbol('PGBASE_OPTIONS');

export interface Resolved {
  readonly schema: ResolvedSchema;
  readonly policies: ReadonlyMap<string, ValidatedPolicy>;
}

export function delegateName(model: string): string {
  return model.length === 0 ? model : model[0]!.toLowerCase() + model.slice(1);
}
