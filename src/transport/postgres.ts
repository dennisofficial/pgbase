import type { Notification, Pool, PoolClient } from 'pg';
import type { WalEvent } from '../wal/types.js';
import { decodeEvent, encodeEvent, payloadByteLength } from './codec.js';
import type { ChangeTransport } from './types.js';

export const NOTIFY_PAYLOAD_LIMIT = 8000;

const DEFAULT_CHANNEL = 'pgbase_wal_events';
const CHANNEL_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface PostgresTransportOptions {
  readonly pool: Pool;
  readonly channel?: string;
}

function oversizedResync(event: WalEvent, encodedBytes: number): WalEvent {
  const model = event.type === 'change' ? event.change.model : null;
  const tables = event.type === 'change' ? [event.change.model] : event.resync.tables;
  const lsn = event.type === 'change' ? event.change.lsn : event.resync.lsn;
  return {
    type: 'resync',
    resync: {
      reason: 'decode-gap',
      detail:
        `Encoded ${event.type} event${model ? ` for "${model}"` : ''} was ${encodedBytes} bytes, ` +
        `over the ${NOTIFY_PAYLOAD_LIMIT}-byte NOTIFY payload limit, and was not delivered. ` +
        `Affected subscribers must resync.`,
      tables,
      lsn,
    },
  };
}

const FALLBACK_RESYNC: WalEvent = {
  type: 'resync',
  resync: {
    reason: 'decode-gap',
    detail: `An event exceeded the ${NOTIFY_PAYLOAD_LIMIT}-byte NOTIFY payload limit.`,
    tables: 'all',
    lsn: null,
  },
};

export class PostgresChangeTransport implements ChangeTransport {
  private readonly pool: Pool;
  private readonly channel: string;
  private readonly listeners = new Set<(event: WalEvent) => void>();
  private client: PoolClient | null = null;

  constructor(opts: PostgresTransportOptions) {
    if (!CHANNEL_RE.test(opts.channel ?? DEFAULT_CHANNEL)) {
      throw new Error(
        `[pgbase] invalid NOTIFY channel name ${JSON.stringify(opts.channel)}; must match ${CHANNEL_RE}.`,
      );
    }
    this.pool = opts.pool;
    this.channel = opts.channel ?? DEFAULT_CHANNEL;
  }

  async start(): Promise<void> {
    if (this.client) return;
    const client = await this.pool.connect();
    client.on('notification', (msg: Notification) => this.onNotification(msg));
    client.on('error', (err: Error) => {
      console.warn(`[pgbase] transport LISTEN connection error: ${err.message}`);
    });
    await client.query(`LISTEN "${this.channel}"`);
    this.client = client;
  }

  async stop(): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.client = null;
    await client.query(`UNLISTEN "${this.channel}"`).catch(() => {});
    client.release();
  }

  async publish(event: WalEvent): Promise<void> {
    const client = this.client;
    if (!client) throw new Error('[pgbase] PostgresChangeTransport.publish() before start().');

    let payload = encodeEvent(event);
    let bytes = payloadByteLength(payload);
    if (bytes > NOTIFY_PAYLOAD_LIMIT) {
      console.warn(
        `[pgbase] transport: encoded ${event.type} event was ${bytes} bytes, over the ` +
          `${NOTIFY_PAYLOAD_LIMIT}-byte NOTIFY payload limit; degrading to a resync instead of ` +
          `dropping or truncating it.`,
      );
      payload = encodeEvent(oversizedResync(event, bytes));
      bytes = payloadByteLength(payload);
      if (bytes > NOTIFY_PAYLOAD_LIMIT) payload = encodeEvent(FALLBACK_RESYNC);
    }
    await client.query('SELECT pg_notify($1, $2)', [this.channel, payload]);
  }

  onEvent(listener: (event: WalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private onNotification(msg: Notification): void {
    if (msg.channel !== this.channel || msg.payload === undefined) return;
    let event: WalEvent;
    try {
      event = decodeEvent(msg.payload);
    } catch (err) {
      console.warn(
        `[pgbase] transport: failed to decode a NOTIFY payload: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    for (const listener of this.listeners) listener(event);
  }
}
