import type { LiveWhere } from '../query/ast.js';

export interface Policy<Row = unknown, Omitted extends keyof Row = never, Claims = unknown> {
  readonly model: string;

  readonly omit: readonly Omitted[];

  readonly rls: (claims: Claims) => LiveWhere;
}

export const NO_CLIENT_ACCESS = Symbol('pgbase.noClientAccess');
export type NoClientAccess = typeof NO_CLIENT_ACCESS;

export type PolicyEntry<Row = unknown, Omitted extends keyof Row = never, Claims = unknown> =
  Policy<Row, Omitted, Claims> | NoClientAccess;

export type ViewOf<P> =
  P extends Policy<infer Row, infer Omitted, any> ? Omit<Row, Omitted> : never;

export interface ProbeResult {
  readonly model: string;
  readonly filterable: ReadonlySet<string>;
}
