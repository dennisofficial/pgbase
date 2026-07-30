export type ChangeKind = 'insert' | 'update' | 'delete';

export type ColumnRow = Record<string, unknown>;

export interface ChangeEvent {
  readonly kind: ChangeKind;
  readonly model: string;
  readonly table: string;
  readonly schema: string;

  readonly lsn: string;
  readonly commitLsn: string;
  readonly commitTime: bigint;

  readonly newRow: ColumnRow | null;
  readonly oldRow: ColumnRow | null;

  readonly unknownColumns: ReadonlySet<string>;
}

export interface ResyncEvent {
  readonly reason: 'truncate' | 'streamed-transaction' | 'slot-recreated' | 'decode-gap';
  readonly detail: string;
  readonly tables: readonly string[] | 'all';
  readonly lsn: string | null;
}

export type WalEvent =
  { type: 'change'; change: ChangeEvent } | { type: 'resync'; resync: ResyncEvent };

export type LeaderState = 'idle' | 'acquiring' | 'streaming' | 'backoff' | 'stopped';

export interface WalLeaderOptions {
  readonly slotName: string;
  readonly publication: string;
  readonly acquireRetryMs?: number;
  readonly statusIntervalMs?: number;
}

export interface WalLeaderStats {
  readonly state: LeaderState;
  readonly lastLsn: string | null;
  readonly lastCommitAt: bigint | null;
  readonly changesEmitted: number;
  readonly resyncsEmitted: number;
  readonly acquireAttempts: number;
}

export interface WalLeader {
  start(): Promise<void>;
  stop(): Promise<void>;
  on(handler: (event: WalEvent) => void): () => void;
  readonly stats: WalLeaderStats;
}

export class WalConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalConfigurationError';
  }
}

export class WalDecodeError extends Error {
  constructor(
    readonly relation: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'WalDecodeError';
  }
}
