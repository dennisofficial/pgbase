import { evaluate } from '../query/evaluate.js';
import type { ChangeEvent, ResyncEvent } from '../wal/types.js';
import {
  LiveRoutingError,
  type ChangeRouter,
  type Delta,
  type RouteResult,
  type Subscription,
  type SubscriptionRegistry,
} from './types.js';

export interface ResyncableRegistry extends SubscriptionRegistry {
  models(): readonly string[];
}

function undecidableReason(change: ChangeEvent, columns: readonly string[]): string {
  return (
    `Column(s) ${columns.map((c) => `"${c}"`).join(', ')} on "${change.model}" are unknown for ` +
    `this ${change.kind} (unresolvable TOAST) and the predicate reads them.`
  );
}

export class DefaultChangeRouter implements ChangeRouter {
  constructor(private readonly registry: ResyncableRegistry) {}

  route(change: ChangeEvent): RouteResult {
    const deltas: Delta[] = [];
    const undecidable: string[] = [];

    for (const sub of this.registry.forModel(change.model)) {
      try {
        this.routeOne(change, sub, deltas, undecidable);
      } catch (err) {
        const routingErr =
          err instanceof LiveRoutingError
            ? err
            : new LiveRoutingError(sub.id, err instanceof Error ? err.message : String(err));
        deltas.push({ kind: 'resync', subscriptionId: sub.id, reason: routingErr.message });
        undecidable.push(sub.id);
      }
    }
    return { deltas, undecidable };
  }

  private routeOne(
    change: ChangeEvent,
    sub: Subscription,
    deltas: Delta[],
    undecidable: string[],
  ): void {
    if (change.kind === 'delete') {
      if (this.heldBefore(sub, change)) {
        deltas.push({
          kind: 'remove',
          subscriptionId: sub.id,
          key: sub.identify(change.oldRow ?? {}),
        });
      }
      return;
    }

    const unknown = [...change.unknownColumns].filter((c) => sub.predicateColumns.has(c));
    if (unknown.length > 0) {
      deltas.push({
        kind: 'resync',
        subscriptionId: sub.id,
        reason: undecidableReason(change, unknown),
      });
      undecidable.push(sub.id);
      return;
    }

    const row = change.newRow!;
    if (evaluate(sub.predicate, row)) {
      deltas.push({ kind: 'upsert', subscriptionId: sub.id, row: sub.project(row) });
      return;
    }
    if (change.kind !== 'update') return;
    if (this.heldBefore(sub, change)) {
      deltas.push({ kind: 'remove', subscriptionId: sub.id, key: sub.identify(row) });
    }
  }

  private heldBefore(sub: Subscription, change: ChangeEvent): boolean {
    const oldRow = change.oldRow;
    if (oldRow !== null && [...sub.predicateColumns].every((c) => c in oldRow)) {
      return evaluate(sub.predicate, oldRow);
    }
    if (change.newRow === null) return true;
    return evaluate(sub.rlsPredicate, change.newRow);
  }

  routeResync(resync: ResyncEvent): RouteResult {
    const models = resync.tables === 'all' ? this.registry.models() : resync.tables;
    const deltas: Delta[] = [];
    const undecidable: string[] = [];
    const seen = new Set<string>();

    for (const model of models) {
      for (const sub of this.registry.forModel(model)) {
        if (seen.has(sub.id)) continue;
        seen.add(sub.id);
        deltas.push({ kind: 'resync', subscriptionId: sub.id, reason: resync.detail });
        undecidable.push(sub.id);
      }
    }
    return { deltas, undecidable };
  }
}
