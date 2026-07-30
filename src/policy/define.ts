import type { LiveWhere } from '../query/ast.js';
import type { Policy, PolicyEntry } from './types.js';

export interface DefinePolicyInput<Row, View, Claims> {
  readonly transform: (row: Row) => View;
  readonly rls: (claims: Claims) => LiveWhere;
}

export function definePolicy<Row, View, Claims>(
  model: string,
  input: DefinePolicyInput<Row, View, Claims>,
): Policy<Row, View, Claims> {
  return { model, transform: input.transform, rls: input.rls };
}

export type PolicyRegistry<ModelName extends string> = {
  readonly [M in ModelName]: PolicyEntry<any, any, any>;
};
