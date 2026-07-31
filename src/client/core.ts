import { io } from 'socket.io-client';
import {
  PGBASE_DELTA,
  PGBASE_SUBSCRIBE,
  PGBASE_UNSUBSCRIBE,
  type SubscribeAck,
  type UnsubscribeAck,
} from '../live/protocol.js';
import type { Delta } from '../live/types.js';
import type { LiveWhere } from '../query/ast.js';
import { PgbaseWireCodec, type WireCodec } from '../read/wire.js';
import { PgbaseHttpError } from './errors.js';
import { SocketSubscription } from './subscription.js';
import type {
  ConnectionStatus,
  CreateClientOptions,
  FindManyArgs,
  GetAuth,
  LiveSocket,
} from './types.js';

function ackToPromise<A extends { ok: boolean }>(
  socket: LiveSocket,
  event: string,
  payload: unknown,
): Promise<A> {
  return new Promise<A>((resolve) => socket.emit(event, payload, (ack: A) => resolve(ack)));
}

const defaultCreateSocket: NonNullable<CreateClientOptions['createSocket']> = (baseUrl, opts) =>
  io(baseUrl, opts) as unknown as LiveSocket;

export class PgbaseCore {
  private readonly wire: WireCodec;
  private readonly baseUrl: string;
  private readonly prefix: string;
  private readonly options: CreateClientOptions;
  private getAuth: GetAuth | undefined;

  private socket: LiveSocket | null = null;
  private connectionStatus: ConnectionStatus = { state: 'idle' };
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  private readonly bySubscriptionId = new Map<string, SocketSubscription<any>>();

  constructor(options: CreateClientOptions) {
    this.options = options;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.prefix = options.prefix ?? 'pgbase';
    this.wire = options.wire ?? new PgbaseWireCodec();
    this.getAuth = options.getAuth;
  }

  private async resolveAuth(): Promise<Record<string, string>> {
    return (await this.getAuth?.()) ?? {};
  }

  setAuth(getAuth: GetAuth | undefined): void {
    this.getAuth = getAuth;
    if (!this.socket) return;
    this.setStatus({ state: 'connecting' });
    const socket = this.socket as unknown as { disconnect(): void; connect(): void };
    socket.disconnect();
    socket.connect();
  }

  async read(model: string, args: FindManyArgs): Promise<unknown> {
    const auth = await this.resolveAuth();
    const fetchImpl = this.options.fetch ?? fetch;
    const res = await fetchImpl(`${this.baseUrl}/${this.prefix}/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ model, args }),
    });
    if (!res.ok) {
      throw new PgbaseHttpError(
        res.status,
        `pgbase read "${model}" failed with ${res.status}: ${await res.text()}`,
      );
    }
    return this.wire.deserialize(await res.json());
  }

  decode<T>(value: unknown): T {
    return this.wire.deserialize(value as Parameters<WireCodec['deserialize']>[0]) as T;
  }

  createSubscription<T>(model: string): SocketSubscription<T> {
    return new SocketSubscription<T>(this, model);
  }

  private ensureSocket(): LiveSocket {
    if (this.socket) return this.socket;
    this.setStatus({ state: 'connecting' });
    const socket = (this.options.createSocket ?? defaultCreateSocket)(this.baseUrl, {
      ...this.options.socketOptions,
      // Called on every (re)connection attempt, so a token that expires mid-session is refreshed
      // automatically rather than baked in once at socket construction.
      auth: (cb: (data: Record<string, string>) => void) => void this.resolveAuth().then(cb),
    });
    socket.on(PGBASE_DELTA, this.onDelta);
    socket.on('connect', this.onConnect);
    socket.on('connect_error', this.onConnectError);
    socket.on('disconnect', this.onDisconnect);
    this.socket = socket;
    return socket;
  }

  sendSubscribe(model: string, where: LiveWhere | undefined): Promise<SubscribeAck> {
    return ackToPromise<SubscribeAck>(this.ensureSocket(), PGBASE_SUBSCRIBE, { model, where });
  }

  sendUnsubscribe(subscriptionId: string): void {
    if (!this.socket) return;
    void ackToPromise<UnsubscribeAck>(this.socket, PGBASE_UNSUBSCRIBE, { subscriptionId });
  }

  bind(subscriptionId: string, subscription: SocketSubscription<any>): void {
    this.bySubscriptionId.set(subscriptionId, subscription);
  }

  unbind(subscriptionId: string): void {
    this.bySubscriptionId.delete(subscriptionId);
  }

  status(): ConnectionStatus {
    return this.connectionStatus;
  }

  onStatusChange(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  dispose(): void {
    if (this.socket) {
      this.socket.off(PGBASE_DELTA, this.onDelta);
      this.socket.off('connect', this.onConnect);
      this.socket.off('connect_error', this.onConnectError);
      this.socket.off('disconnect', this.onDisconnect);
      (this.socket as unknown as { close?: () => void }).close?.();
    }
    this.bySubscriptionId.clear();
    this.statusListeners.clear();
  }

  private setStatus(status: ConnectionStatus): void {
    this.connectionStatus = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private readonly onDelta = (payload: unknown): void => {
    const delta = this.decode<Delta>(payload);
    this.bySubscriptionId.get(delta.subscriptionId)?.applyDelta(delta);
  };

  private readonly onConnect = (): void => {
    this.setStatus({ state: 'connected' });
    for (const subscription of new Set(this.bySubscriptionId.values())) subscription.reconnect();
  };

  private readonly onConnectError = (error: Error): void => {
    this.setStatus({ state: 'error', error });
  };

  private readonly onDisconnect = (): void => {
    if (this.connectionStatus.state !== 'error') this.setStatus({ state: 'disconnected' });
  };
}
