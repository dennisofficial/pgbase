import type { ResolvedField } from '../schema/types.js';

export type ComparisonOp =
  'equals' | 'not' | 'lt' | 'lte' | 'gt' | 'gte' | 'contains' | 'startsWith' | 'endsWith';

export type SetOp = 'in' | 'notIn';

export type ListOp = 'has' | 'hasSome' | 'hasEvery' | 'isEmpty';

export type PredicateNode =
  | { readonly kind: 'and'; readonly children: readonly PredicateNode[] }
  | { readonly kind: 'or'; readonly children: readonly PredicateNode[] }
  | { readonly kind: 'not'; readonly child: PredicateNode }
  | { readonly kind: 'literal'; readonly value: boolean }
  | {
      readonly kind: 'compare';
      readonly field: ResolvedField;
      readonly op: ComparisonOp;
      readonly value: unknown;
      readonly insensitive: boolean;
    }
  | {
      readonly kind: 'set';
      readonly field: ResolvedField;
      readonly op: SetOp;
      readonly values: readonly unknown[];
    }
  | {
      readonly kind: 'list';
      readonly field: ResolvedField;
      readonly op: ListOp;
      readonly values: readonly unknown[];
    }
  | { readonly kind: 'isNull'; readonly field: ResolvedField; readonly negated: boolean };

// ─────────────────────────────────────────────────────────────────────────────
// Wire surface
// ─────────────────────────────────────────────────────────────────────────────

/** Prisma allows the singular form everywhere it allows a list. */
export type OneOrMany<T> = T | T[];

export interface LiveScalarFilter<T> {
  equals?: T;
  in?: T[];
  notIn?: T[];
  lt?: T;
  lte?: T;
  gt?: T;
  gte?: T;
  not?: T | LiveScalarFilter<T>;
}

export interface LiveNullableScalarFilter<T> {
  equals?: T | null;
  in?: T[];
  notIn?: T[];
  lt?: T;
  lte?: T;
  gt?: T;
  gte?: T;
  not?: T | null | LiveNullableScalarFilter<T>;
}

interface StringOps {
  in?: string[];
  notIn?: string[];
  lt?: string;
  lte?: string;
  gt?: string;
  gte?: string;
  contains?: string;
  startsWith?: string;
  endsWith?: string;
  /** Prisma's `QueryMode`. `'default'` is accepted and is a no-op, so a shared query can set it. */
  mode?: 'default' | 'insensitive';
}

export interface LiveStringFilter extends StringOps {
  equals?: string;
  not?: string | LiveStringFilter;
}

export interface LiveNullableStringFilter extends StringOps {
  equals?: string | null;
  not?: string | null | LiveNullableStringFilter;
}

export interface LiveBoolFilter {
  equals?: boolean;
  not?: boolean | LiveBoolFilter;
}

export interface LiveNullableBoolFilter {
  equals?: boolean | null;
  not?: boolean | null | LiveNullableBoolFilter;
}

/** Scalar lists (`String[]`). Prisma names these `*NullableListFilter` / `*ListFilter`. */
export interface LiveListFilter<T> {
  equals?: T[] | null;
  has?: T | null;
  hasEvery?: T[];
  hasSome?: T[];
  isEmpty?: boolean;
}

export type LiveFieldFilter =
  | LiveStringFilter
  | LiveNullableStringFilter
  | LiveBoolFilter
  | LiveNullableBoolFilter
  | LiveScalarFilter<unknown>
  | LiveNullableScalarFilter<unknown>
  | LiveListFilter<unknown>;

export type LiveWhere = {
  AND?: OneOrMany<LiveWhere>;
  OR?: LiveWhere[];
  NOT?: OneOrMany<LiveWhere>;
} & {
  [field: string]: unknown;
};

export const TRUE: PredicateNode = { kind: 'literal', value: true };
export const FALSE: PredicateNode = { kind: 'literal', value: false };

// ─────────────────────────────────────────────────────────────────────────────
// Comparison
// ─────────────────────────────────────────────────────────────────────────────

/** SQL's three-valued logic. `null` is UNKNOWN; only `true` passes a filter. */
export type Truth = boolean | null;

export interface Comparator {
  /** Negative, zero, positive. Never called with null on either side. */
  compare(a: unknown, b: unknown): number;
  equals(a: unknown, b: unknown): boolean;
}
