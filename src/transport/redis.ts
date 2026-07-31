import type { WalEvent } from '../wal/types.js';
import { decodeEvent, encodeEvent } from './codec.js';
import type { ChangeTransport } from './types.js';

const DEFAULT_CHANNEL = 'pgbase:wal-events';

export interface RedisLike {
  publish(channel: string, message: string): unknown;
  subscribe(channel: string): unknown;
  unsubscribe(channel: string): unknown;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  off(event: 'message', listener: (channel: string, message: string) => void): unknown;
  duplicate?(): RedisLike;
  quit?(): unknown;
}

export interface RedisTransportOptions {
  readonly client: RedisLike;
  readonly subscriber?: RedisLike;
  readonly channel?: string;
}

export class RedisChangeTransport implements ChangeTransport {
  private readonly publisher: RedisLike;
  private readonly subscriber: RedisLike;
  private readonly ownsSubscriber: boolean;
  private readonly channel: string;
  private readonly listeners = new Set<(event: WalEvent) => void>();
  private started = false;

  private readonly onMessage = (channel: string, message: string): void => {
    if (channel !== this.channel) return;
    let event: WalEvent;
    try {
      event = decodeEvent(message);
    } catch (err) {
      console.warn(
        `[pgbase] transport: failed to decode a Redis pub/sub payload: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    for (const listener of this.listeners) listener(event);
  };

  constructor(opts: RedisTransportOptions) {
    this.publisher = opts.client;
    this.channel = opts.channel ?? DEFAULT_CHANNEL;
    if (opts.subscriber) {
      this.subscriber = opts.subscriber;
      this.ownsSubscriber = false;
    } else if (opts.client.duplicate) {
      this.subscriber = opts.client.duplicate();
      this.ownsSubscriber = true;
    } else {
      throw new Error(
        '[pgbase] RedisChangeTransport needs a dedicated subscribe connection: pass `subscriber`, ' +
          'or `client` must implement `duplicate()`.',
      );
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.subscriber.on('message', this.onMessage);
    await this.subscriber.subscribe(this.channel);
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await Promise.resolve(this.subscriber.unsubscribe(this.channel)).catch(() => {});
    this.subscriber.off('message', this.onMessage);
    if (this.ownsSubscriber) await Promise.resolve(this.subscriber.quit?.()).catch(() => {});
  }

  async publish(event: WalEvent): Promise<void> {
    await Promise.resolve(this.publisher.publish(this.channel, encodeEvent(event)));
  }

  onEvent(listener: (event: WalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
