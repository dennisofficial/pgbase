import {
  PGBASE_DELTA,
  PGBASE_SUBSCRIBE,
  PGBASE_UNSUBSCRIBE,
  keyOf,
  type SubscribeAck,
  type UnsubscribeAck,
} from '../live/protocol.js';
import type { Delta } from '../live/types.js';
import { createWireCodec, type WireCodec, type WireCustomType } from '../read/wire.js';

export { createWireCodec };
export type { WireCodec, WireCustomType };

export interface LiveSocket {
  readonly connected: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  emit(event: string, ...args: any[]): unknown;
}

export interface PgbaseClientOptions {
  readonly socket: LiveSocket;
  readonly wire?: WireCodec;
}

export interface LiveQueryHandle<T = unknown> {
  getSnapshot(): readonly T[];
  subscribe(listener: () => void): () => void;
  close(): void;
}

function decode<T>(wire: WireCodec, value: unknown): T {
  return wire.deserialize(value as Parameters<WireCodec['deserialize']>[0]) as T;
}

function ackToPromise<A extends { ok: boolean }>(
  socket: LiveSocket,
  event: string,
  payload: unknown,
): Promise<A> {
  return new Promise<A>((resolve) => socket.emit(event, payload, (ack: A) => resolve(ack)));
}

class LiveQuery<T> implements LiveQueryHandle<T> {
  private serverSubscriptionId: string | null = null;
  private primaryKey: readonly string[] = [];
  private state = new Map<string, T>();
  private rows: readonly T[] = [];
  private readonly listeners = new Set<() => void>();
  private closed = false;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly client: PgbaseClient,
    private readonly model: string,
    private readonly where: Record<string, unknown> | undefined,
  ) {
    this.resync();
  }

  getSnapshot = (): readonly T[] => this.rows;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.serverSubscriptionId) {
      this.client.unbind(this.serverSubscriptionId);
      this.client.sendUnsubscribe(this.serverSubscriptionId);
    }
  }

  resync(): Promise<void> {
    this.inFlight = this.inFlight.then(() => this.doResync());
    return this.inFlight;
  }

  private async doResync(): Promise<void> {
    if (this.closed) return;
    const ack = await this.client.sendSubscribe(this.model, this.where);
    if (this.closed) {
      if (ack.ok) this.client.sendUnsubscribe(ack.subscriptionId);
      return;
    }
    if (!ack.ok) {
      // Left un-bound; the caller sees no data change. A real app would surface `ack.error`.
      return;
    }
    const previous = this.serverSubscriptionId;
    this.serverSubscriptionId = ack.subscriptionId;
    this.primaryKey = ack.primaryKey;
    this.client.bind(ack.subscriptionId, this);
    if (previous) this.client.unbind(previous);

    const snapshot = decode<T[]>(this.client.wire, ack.snapshot);
    this.state = new Map(snapshot.map((row) => [this.keyOf(row as Record<string, unknown>), row]));
    this.publish();
  }

  applyDelta(delta: Delta): void {
    if (delta.kind === 'upsert') {
      this.state.set(this.keyOf(delta.row as Record<string, unknown>), delta.row as T);
    } else if (delta.kind === 'remove') {
      this.state.delete(this.keyOf(delta.key));
    } else {
      void this.resync();
      return;
    }
    this.publish();
  }

  private keyOf(row: Record<string, unknown>): string {
    return keyOf(this.primaryKey, row);
  }

  private publish(): void {
    this.rows = [...this.state.values()];
    for (const listener of this.listeners) listener();
  }
}

export class PgbaseClient {
  readonly wire: WireCodec;
  private readonly socket: LiveSocket;
  private readonly bySubscriptionId = new Map<string, LiveQuery<any>>();
  private readonly onDeltaHandler = (payload: unknown): void => this.onDelta(payload);
  private readonly onConnectHandler = (): void => this.onConnect();

  constructor(options: PgbaseClientOptions) {
    this.socket = options.socket;
    this.wire = options.wire ?? createWireCodec();
    this.socket.on(PGBASE_DELTA, this.onDeltaHandler);
    this.socket.on('connect', this.onConnectHandler);
  }

  liveQuery<T = unknown>(model: string, where?: Record<string, unknown>): LiveQueryHandle<T> {
    return new LiveQuery<T>(this, model, where);
  }

  dispose(): void {
    this.socket.off(PGBASE_DELTA, this.onDeltaHandler);
    this.socket.off('connect', this.onConnectHandler);
  }

  /** @internal */
  bind(subscriptionId: string, query: LiveQuery<any>): void {
    this.bySubscriptionId.set(subscriptionId, query);
  }

  /** @internal */
  unbind(subscriptionId: string): void {
    this.bySubscriptionId.delete(subscriptionId);
  }

  /** @internal */
  sendSubscribe(model: string, where: Record<string, unknown> | undefined): Promise<SubscribeAck> {
    return ackToPromise<SubscribeAck>(this.socket, PGBASE_SUBSCRIBE, { model, where });
  }

  /** @internal */
  sendUnsubscribe(subscriptionId: string): void {
    void ackToPromise<UnsubscribeAck>(this.socket, PGBASE_UNSUBSCRIBE, { subscriptionId });
  }

  private onDelta(payload: unknown): void {
    const delta = decode<Delta>(this.wire, payload);
    this.bySubscriptionId.get(delta.subscriptionId)?.applyDelta(delta);
  }

  /** A `connect` firing with existing bound subscriptions means the transport reconnected under us — rebuild every one from a fresh snapshot. First connect has nothing bound yet, so this is a no-op then. */
  private onConnect(): void {
    for (const query of new Set(this.bySubscriptionId.values())) void query.resync();
  }
}
