import { keyOf, type SubscribeAck } from '../live/protocol.js';
import type { Delta } from '../live/types.js';
import type { LiveWhere } from '../query/ast.js';
import { PgbaseSubscribeError } from './errors.js';
import type { LiveArgs, Subscription } from './types.js';

export interface SubscriptionHost {
  sendSubscribe(model: string, where: LiveWhere | undefined): Promise<SubscribeAck>;
  sendUnsubscribe(subscriptionId: string): void;
  bind(subscriptionId: string, subscription: SocketSubscription<any>): void;
  unbind(subscriptionId: string): void;
  decode<T>(value: unknown): T;
}

export class SocketSubscription<T> implements Subscription<T> {
  private serverSubscriptionId: string | null = null;
  private primaryKey: readonly string[] = [];
  private state = new Map<string, T>();
  private rows: readonly T[] = [];
  private where: LiveWhere | undefined;
  private closed = false;
  private inFlight: Promise<readonly T[]> = Promise.resolve([]);
  private readonly listeners = new Set<(rows: readonly T[]) => void>();

  constructor(
    private readonly host: SubscriptionHost,
    private readonly model: string,
  ) {}

  query(args: LiveArgs = {}): Promise<readonly T[]> {
    this.where = args.where;
    this.inFlight = this.inFlight.then(
      () => this.resync(),
      () => this.resync(),
    );
    return this.inFlight;
  }

  getSnapshot = (): readonly T[] => this.rows;

  subscribe = (listener: (rows: readonly T[]) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.serverSubscriptionId) {
      this.host.unbind(this.serverSubscriptionId);
      this.host.sendUnsubscribe(this.serverSubscriptionId);
    }
  }

  /** @internal the transport reconnected under us — rebuild from a fresh snapshot, never resume. */
  reconnect(): void {
    void this.query({ where: this.where }).catch(() => {});
  }

  /** @internal */
  applyDelta(delta: Delta): void {
    if (delta.kind === 'upsert') {
      this.state.set(this.keyOf(delta.row as Record<string, unknown>), delta.row as T);
    } else if (delta.kind === 'remove') {
      this.state.delete(this.keyOf(delta.key));
    } else {
      void this.query({ where: this.where }).catch(() => {});
      return;
    }
    this.publish();
  }

  private async resync(): Promise<readonly T[]> {
    if (this.closed) return this.rows;
    const ack = await this.host.sendSubscribe(this.model, this.where);
    if (this.closed) {
      if (ack.ok) this.host.sendUnsubscribe(ack.subscriptionId);
      return this.rows;
    }
    if (!ack.ok) throw new PgbaseSubscribeError(ack.error.name, ack.error.message);

    const previous = this.serverSubscriptionId;
    this.serverSubscriptionId = ack.subscriptionId;
    this.primaryKey = ack.primaryKey;
    this.host.bind(ack.subscriptionId, this);
    if (previous) this.host.unbind(previous);

    const snapshot = this.host.decode<T[]>(ack.snapshot);
    this.state = new Map(snapshot.map((row) => [this.keyOf(row as Record<string, unknown>), row]));
    this.publish();
    return this.rows;
  }

  private keyOf(row: Record<string, unknown>): string {
    return keyOf(this.primaryKey, row);
  }

  private publish(): void {
    this.rows = [...this.state.values()];
    for (const listener of this.listeners) listener(this.rows);
  }
}
