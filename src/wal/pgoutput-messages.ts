export const TOAST_UNCHANGED: unique symbol = Symbol('pgbase.wal.toastUnchanged');

export type RawValue = string | null | typeof TOAST_UNCHANGED;
export type RawTuple = Record<string, RawValue>;

export type ReplicaIdentityWire = 'default' | 'nothing' | 'full' | 'index';

export interface RelationColumn {
  readonly name: string;
  readonly typeOid: number;
  readonly isKey: boolean;
}

export interface RelationMessage {
  readonly tag: 'relation';
  readonly relationOid: number;
  readonly schema: string;
  readonly name: string;
  readonly replicaIdentity: ReplicaIdentityWire;
  readonly columns: readonly RelationColumn[];
}

export interface BeginMessage {
  readonly tag: 'begin';
  readonly commitLsn: string;
  readonly commitTime: bigint;
  readonly xid: number;
}

export interface CommitMessage {
  readonly tag: 'commit';
  readonly commitLsn: string;
  readonly commitEndLsn: string;
  readonly commitTime: bigint;
}

export interface OriginMessage {
  readonly tag: 'origin';
  readonly originLsn: string | null;
  readonly originName: string;
}

export interface TypeMessage {
  readonly tag: 'type';
  readonly typeOid: number;
  readonly typeSchema: string;
  readonly typeName: string;
}

export interface InsertMessage {
  readonly tag: 'insert';
  readonly relationOid: number;
  readonly new: RawTuple;
}

export interface UpdateMessage {
  readonly tag: 'update';
  readonly relationOid: number;
  /** Present only under default/index identity when a key column changed. Key columns only. */
  readonly key: RawTuple | null;
  /** Present only under FULL identity. Every published column. */
  readonly old: RawTuple | null;
  readonly new: RawTuple;
}

export interface DeleteMessage {
  readonly tag: 'delete';
  readonly relationOid: number;
  readonly key: RawTuple | null;
  readonly old: RawTuple | null;
}

export interface TruncateMessage {
  readonly tag: 'truncate';
  readonly cascade: boolean;
  readonly restartIdentity: boolean;
  readonly relationOids: readonly number[];
}

export interface StreamMessage {
  readonly tag: 'stream';
  readonly kind: 'start' | 'stop' | 'commit' | 'abort';
}

export interface MessageMessage {
  readonly tag: 'message';
}

export type PgoutputMessage =
  | BeginMessage
  | CommitMessage
  | OriginMessage
  | TypeMessage
  | RelationMessage
  | InsertMessage
  | UpdateMessage
  | DeleteMessage
  | TruncateMessage
  | StreamMessage
  | MessageMessage;
