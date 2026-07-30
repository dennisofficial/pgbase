import type { LiveWhere } from '../query/ast.js';
import type { Policy, PolicyEntry } from './types.js';

export interface DefinePolicyInput<Row, Claims, Omitted extends readonly (keyof Row)[]> {
  readonly omit?: Omitted;
  readonly rls: (claims: Claims) => LiveWhere;
}

export function definePolicy<Row, Claims>(model: string) {
  return function <const Omitted extends readonly (keyof Row)[] = readonly []>(
    input: DefinePolicyInput<Row, Claims, Omitted>,
  ): Policy<Row, Omitted[number], Claims> {
    return { model, omit: (input.omit ?? []) as readonly Omitted[number][], rls: input.rls };
  };
}

export type PolicyRegistry<ModelName extends string> = {
  readonly [M in ModelName]: PolicyEntry<any, any, any>;
};
