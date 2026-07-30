export interface ClaimsBuilder<Principal = unknown, Claims = unknown> {
  key(principal: Principal): string;

  build(principal: Principal): Promise<Claims>;

  readonly ttlMs?: number;
}

export interface RequestContext<Principal = unknown, Claims = unknown> {
  readonly principal: Principal;
  readonly claims: Claims;
}

export interface ContextStore<Principal = unknown, Claims = unknown> {
  run<T>(ctx: RequestContext<Principal, Claims>, fn: () => T): T;
  get(): RequestContext<Principal, Claims> | undefined;
  runUnscoped<T>(reason: string, fn: () => T): T;
  isUnscoped(): boolean;
}

export interface ClaimsCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly coalesced: number;
}

export interface ClaimsCache<Principal = unknown, Claims = unknown> {
  get(principal: Principal): Promise<Claims>;
  invalidate(key: string): void;
  invalidateAll(): void;
  readonly stats: ClaimsCacheStats;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoped writes
// ─────────────────────────────────────────────────────────────────────────────

export type WriteKind = 'create' | 'update' | 'delete';

export class ScopeViolationError extends Error {
  constructor(
    readonly model: string,
    readonly kind: WriteKind,
    message: string,
  ) {
    super(message);
    this.name = 'ScopeViolationError';
  }
}
