import type { LiveWhere } from '../query/ast.js';
import type { ResolvedModel } from '../schema/types.js';

export interface Policy<Row = unknown, View = unknown, Claims = unknown> {
  readonly model: string;

  readonly transform: (row: Row) => View;

  readonly rls: (claims: Claims) => LiveWhere;
}

/** Deliberate opt-out. Distinguishes "no client access" from "someone forgot this model". */
export const NO_CLIENT_ACCESS = Symbol('pgbase.noClientAccess');
export type NoClientAccess = typeof NO_CLIENT_ACCESS;

export type PolicyEntry<Row = unknown, View = unknown, Claims = unknown> =
  Policy<Row, View, Claims> | NoClientAccess;

// ─────────────────────────────────────────────────────────────────────────────
// Sentinel probe
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How a column survives `transform`.
 *
 * `whole`     — the column's value appears unchanged at some output path. Returned AND filterable.
 * `derived`   — the value appears only embedded in something else (concatenated, formatted,
 *               truncated). Returned in that derived form, but NOT filterable: an equality or
 *               `startsWith` on the raw column is an oracle for more than the output reveals.
 * `absent`    — no trace. Not returned, not filterable.
 */
export type Exposure = 'whole' | 'derived' | 'absent';

export interface ProbeResult {
  readonly model: string;
  readonly exposure: ReadonlyMap<string, Exposure>;
  /** Output path (dotted) → field name, for `whole` exposures only. */
  readonly viewPaths: ReadonlyMap<string, string>;
  readonly filterable: ReadonlySet<string>;
}

export interface Prober {
  probe(model: ResolvedModel, transform: (row: never) => unknown): ProbeResult;
}
