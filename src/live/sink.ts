import type { ResyncEvent, WalEvent } from '../wal/types.js';
import { DEFAULT_SINK_LIMITS, type ChangeSink, type SinkLimits } from './types.js';

function overflowResync(maxQueued: number): ResyncEvent {
  return {
    reason: 'decode-gap',
    detail: `Sink exceeded ${maxQueued} queued events before draining; backlog dropped.`,
    tables: 'all',
    lsn: null,
  };
}

export class InMemoryChangeSink implements ChangeSink {
  private readonly queue: WalEvent[] = [];
  private readonly consumers = new Set<(event: WalEvent) => void>();
  private readonly limits: SinkLimits;
  private scheduled = false;

  constructor(limits: SinkLimits = DEFAULT_SINK_LIMITS) {
    this.limits = limits;
  }

  push(event: WalEvent): void {
    if (this.queue.length >= this.limits.maxQueued) {
      this.queue.length = 0;
      this.queue.push({ type: 'resync', resync: overflowResync(this.limits.maxQueued) });
    } else {
      this.queue.push(event);
    }
    this.schedule();
  }

  onEvent(consumer: (event: WalEvent) => void): () => void {
    this.consumers.add(consumer);
    return () => this.consumers.delete(consumer);
  }

  get queued(): number {
    return this.queue.length;
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => this.drain());
  }

  private drain(): void {
    this.scheduled = false;
    while (this.queue.length > 0) {
      const event = this.queue.shift()!;
      for (const consumer of this.consumers) consumer(event);
    }
  }
}
