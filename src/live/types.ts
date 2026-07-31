import type { PredicateNode } from '../query/ast.js';
import type { ChangeEvent, ResyncEvent, WalEvent } from '../wal/types.js';

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
  readonly project: (row: unknown) => unknown;
}

/**
 * Deltas are keyed by primary key and are idempotent, which is what lets routing stay correct
 * without REPLICA IDENTITY FULL.
 *
 * For an UPDATE we frequently cannot know whether the row matched BEFORE the change — a default
 * replica identity gives us only the key in the pre-image. Rather than guess, routing decides
 * purely from the post-image: if the new row matches, emit `upsert`; if it does not, emit `remove`.
 * A `remove` for a row the client never held is a no-op, and an `upsert` for one it already has is
 * a replace, so the client's set converges to the correct membership either way.
 *
 * The consequence worth stating plainly: FULL is NOT required for set membership to be correct. It
 * is required only when a subscriber needs the row's previous *values* — which is Tier 3 territory,
 * not this phase.
 */
export type Delta =
  | { readonly kind: 'upsert'; readonly subscriptionId: string; readonly row: unknown }
  | { readonly kind: 'remove'; readonly subscriptionId: string; readonly key: unknown }
  | { readonly kind: 'resync'; readonly subscriptionId: string; readonly reason: string };

export interface RouteResult {
  readonly deltas: readonly Delta[];
  /** Subscriptions that could not be decided and must refetch. Never silently dropped. */
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
