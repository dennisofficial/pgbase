import type { WalEvent } from '../wal/types.js';

export interface ChangeTransport {
  publish(event: WalEvent): Promise<void> | void;
  onEvent(listener: (event: WalEvent) => void): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
}
