import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { ChangeEvent, WalEvent } from '../../wal/types.js';
import { RedisChangeTransport, type RedisLike } from '../redis.js';

class FakeRedisBus {
  private readonly channels = new Map<string, Set<FakeRedisClient>>();

  connect(): FakeRedisClient {
    return new FakeRedisClient(this);
  }

  subscribe(channel: string, client: FakeRedisClient): void {
    let set = this.channels.get(channel);
    if (!set) this.channels.set(channel, (set = new Set()));
    set.add(client);
  }

  unsubscribe(channel: string, client: FakeRedisClient): void {
    this.channels.get(channel)?.delete(client);
  }

  publish(channel: string, message: string): number {
    const set = this.channels.get(channel);
    if (!set) return 0;
    for (const client of set) client.deliver(channel, message);
    return set.size;
  }
}

class FakeRedisClient extends EventEmitter implements RedisLike {
  constructor(private readonly bus: FakeRedisBus) {
    super();
  }

  publish(channel: string, message: string): number {
    return this.bus.publish(channel, message);
  }

  subscribe(channel: string): void {
    this.bus.subscribe(channel, this);
  }

  unsubscribe(channel: string): void {
    this.bus.unsubscribe(channel, this);
  }

  duplicate(): FakeRedisClient {
    return this.bus.connect();
  }

  quit(): void {}

  deliver(channel: string, message: string): void {
    this.emit('message', channel, message);
  }
}

function baseChange(overrides: Partial<ChangeEvent> = {}): WalEvent {
  const change: ChangeEvent = {
    kind: 'insert',
    model: 'Widget',
    table: 'widgets',
    schema: 'public',
    lsn: '0/1000',
    commitLsn: '0/1000',
    commitTime: 1n,
    newRow: { id: 1n, label: 'x' },
    oldRow: null,
    unknownColumns: new Set(),
    ...overrides,
  };
  return { type: 'change', change };
}

describe('RedisChangeTransport', () => {
  it('round-trips a published event, including a payload well over the NOTIFY limit', async () => {
    const bus = new FakeRedisBus();
    const client = bus.connect();
    const transport = new RedisChangeTransport({ client });
    await transport.start();

    const received: WalEvent[] = [];
    transport.onEvent((e) => received.push(e));

    const huge = baseChange({ newRow: { id: 1n, blob: 'y'.repeat(50_000) } });
    await transport.publish(huge);

    expect(received).toHaveLength(1);
    const got = received[0]!;
    expect(got.type).toBe('change'); // no 8000-byte cap on this transport — never degraded
    if (got.type !== 'change') throw new Error('unreachable');
    expect((got.change.newRow!.blob as string).length).toBe(50_000);
    expect(got.change.newRow!.id).toBe(1n);

    await transport.stop();
  });

  it('publish and subscribe use separate connections via duplicate()', async () => {
    const bus = new FakeRedisBus();
    const client = bus.connect();
    let duplicated = 0;
    const wrapped: RedisLike = {
      publish: client.publish.bind(client),
      subscribe: client.subscribe.bind(client),
      unsubscribe: client.unsubscribe.bind(client),
      on: client.on.bind(client),
      off: client.off.bind(client),
      duplicate: () => {
        duplicated++;
        return client.duplicate();
      },
    };
    const transport = new RedisChangeTransport({ client: wrapped });
    await transport.start();
    expect(duplicated).toBe(1);
    await transport.stop();
  });

  it('accepts an explicit subscriber instead of requiring duplicate()', async () => {
    const bus = new FakeRedisBus();
    const client = bus.connect();
    const subscriber = bus.connect();
    const transport = new RedisChangeTransport({ client, subscriber });
    await transport.start();

    const received: WalEvent[] = [];
    transport.onEvent((e) => received.push(e));
    await transport.publish(baseChange());
    expect(received).toHaveLength(1);

    await transport.stop();
  });

  it('throws if neither a subscriber nor duplicate() is available', () => {
    const client: RedisLike = {
      publish: () => 0,
      subscribe: () => {},
      unsubscribe: () => {},
      on: () => {},
      off: () => {},
    };
    expect(() => new RedisChangeTransport({ client })).toThrow(/subscriber/);
  });

  it('stop() unsubscribes: events published afterward are not delivered', async () => {
    const bus = new FakeRedisBus();
    const client = bus.connect();
    const transport = new RedisChangeTransport({ client });
    await transport.start();
    const received: WalEvent[] = [];
    transport.onEvent((e) => received.push(e));

    await transport.stop();
    bus.publish('pgbase:wal-events', JSON.stringify({ ignored: true }));
    expect(received).toHaveLength(0);
  });
});
