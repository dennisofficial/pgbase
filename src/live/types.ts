import type { PredicateNode } from '../query/ast.js';
import type { ChangeEvent, ColumnRow, ResyncEvent, WalEvent } from '../wal/types.js';

export interface ChangeSink {
  push(event: WalEvent): void;
}

export interface SinkLimits {
  readonly maxQueued: number;
  readonly onOverflow: 'resync';
}

export const DEFAULT_SINK_LIMITS: SinkLimits = { maxQueued: 10_000, onOverflow: 'resync' };

export interface Subscription {
  readonly id: string;
  readonly model: string;
  readonly predicate: PredicateNode;
  readonly predicateColumns: ReadonlySet<string>;
  readonly rlsPredicate: PredicateNode;
  readonly rlsColumns: ReadonlySet<string>;
  readonly project: (row: ColumnRow) => unknown;
  readonly identify: (row: ColumnRow) => Record<string, unknown>;
}

export type Delta =
  | { readonly kind: 'upsert'; readonly subscriptionId: string; readonly row: unknown }
  | {
      readonly kind: 'remove';
      readonly subscriptionId: string;
      readonly key: Record<string, unknown>;
    }
  | { readonly kind: 'resync'; readonly subscriptionId: string; readonly reason: string };

export interface RouteResult {
  readonly deltas: readonly Delta[];
  readonly undecidable: readonly string[];
}

export interface SubscriptionRegistry {
  add(subscription: Subscription): () => void;
  forModel(model: string): readonly Subscription[];
  readonly size: number;
}

export interface ChangeRouter {
  route(change: ChangeEvent): RouteResult;
  routeResync(resync: ResyncEvent): RouteResult;
}

export class LiveRoutingError extends Error {
  constructor(
    readonly subscriptionId: string,
    message: string,
  ) {
    super(message);
    this.name = 'LiveRoutingError';
  }
}
