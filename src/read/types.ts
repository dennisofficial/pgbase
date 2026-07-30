import type { LiveWhere } from '../query/ast.js';

export interface ReadArgs {
  where?: LiveWhere;
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
  orderBy?: unknown;
  take?: number;
  skip?: number;
  cursor?: Record<string, unknown>;
  distinct?: unknown;
}

export interface ReadLimits {
  readonly maxRows: number;
  readonly statementTimeoutMs: number;
}

export const DEFAULT_READ_LIMITS: ReadLimits = {
  maxRows: 200,
  statementTimeoutMs: 5_000,
};

export interface ScopedRead {
  readonly args: ReadArgs;
  readonly plan: ResultPlan;
}

export interface ResultPlan {
  readonly model: string;
  readonly transform: (row: unknown) => unknown;
  readonly relations: ReadonlyMap<string, ResultPlan>;
}

export class ReadValidationError extends Error {
  constructor(
    readonly model: string,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'ReadValidationError';
  }
}
