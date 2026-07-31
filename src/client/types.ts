import type { ManagerOptions, SocketOptions } from 'socket.io-client';
import type { LiveWhere } from '../query/ast.js';
import type { ReadArgs } from '../read/types.js';
import type { WireCodec } from '../read/wire.js';

export type FindManyArgs = ReadArgs;
export type FindOneArgs = Omit<ReadArgs, 'take'>;

export interface LiveArgs {
  readonly where?: LiveWhere;
}

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

export interface ConnectionStatus {
  readonly state: ConnectionState;
  readonly error?: Error;
}

export interface Subscription<T> {
  query(args?: LiveArgs): Promise<readonly T[]>;
  getSnapshot(): readonly T[];
  subscribe(listener: (rows: readonly T[]) => void): () => void;
  close(): void;
}

export interface ModelAccessor<T> {
  findMany(args?: FindManyArgs): Promise<readonly T[]>;
  findOne(args?: FindOneArgs): Promise<T | null>;
  subscribeMany(
    args: LiveArgs & {
      onUpdate: (rows: readonly T[]) => void;
      onError?: (error: Error) => void;
    },
  ): () => void;
  subscribeOne(
    args: LiveArgs & {
      onUpdate: (row: T | null) => void;
      onError?: (error: Error) => void;
    },
  ): () => void;
  createSubscription(): Subscription<T>;
}

export type PgbaseClient<Models extends object> = {
  readonly [K in keyof Models]: ModelAccessor<Models[K]>;
} & {
  $status(): ConnectionStatus;
  $onStatusChange(listener: (status: ConnectionStatus) => void): () => void;
  $setAuth(getAuth: GetAuth | Record<string, string> | undefined): void;
  $dispose(): void;
};

export interface LiveSocket {
  readonly connected: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  emit(event: string, ...args: any[]): unknown;
}

export type GetAuth = () =>
  Record<string, string> | undefined | Promise<Record<string, string> | undefined>;

export interface CreateClientOptions {
  readonly baseUrl: string;
  readonly getAuth?: GetAuth;
  readonly prefix?: string;
  readonly wire?: WireCodec;
  readonly fetch?: typeof fetch;
  readonly socketOptions?: Partial<ManagerOptions & SocketOptions>;
  readonly createSocket?: (
    baseUrl: string,
    opts: Partial<ManagerOptions & SocketOptions>,
  ) => LiveSocket;
}
