import { WalDecodeError } from './types.js';

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

const textDecoder = new TextDecoder();

class BinaryReader {
  private pos = 0;

  constructor(private readonly buf: Buffer) {}

  private need(n: number): void {
    if (this.buf.length < this.pos + n) {
      throw new WalDecodeError(null, 'pgoutput message ended before an expected field.');
    }
  }

  readUint8(): number {
    this.need(1);
    return this.buf[this.pos++]!;
  }

  readInt16(): number {
    this.need(2);
    const v = (this.buf[this.pos]! << 8) | this.buf[this.pos + 1]!;
    this.pos += 2;
    return v;
  }

  readInt32(): number {
    this.need(4);
    const v = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  readUint32(): number {
    this.need(4);
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  readUint64(): bigint {
    this.need(8);
    const v = this.buf.readBigUInt64BE(this.pos);
    this.pos += 8;
    return v;
  }

  readBytes(n: number): Buffer {
    this.need(n);
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  readString(): string {
    const end = this.buf.indexOf(0x00, this.pos);
    if (end < 0) throw new WalDecodeError(null, 'pgoutput message: unterminated string field.');
    const v = textDecoder.decode(this.buf.subarray(this.pos, end));
    this.pos = end + 1;
    return v;
  }

  /** LSN wire format: two uint32s, rendered as Postgres's canonical "HEX/HEX" text form. */
  readLsn(): string {
    const hi = this.readUint32();
    const lo = this.readUint32();
    return `${hi.toString(16).toUpperCase()}/${lo.toString(16).toUpperCase()}`;
  }

  /** Microseconds since the Postgres epoch (2000-01-01), converted to microseconds since the
   * Unix epoch — the same bigint representation `parseTimestampMicros` produces. */
  readTime(): bigint {
    return this.readUint64() + 946_684_800_000_000n;
  }
}

function decodeReplicaIdentity(byte: number): ReplicaIdentityWire {
  switch (byte) {
    case 0x64 /* d */:
      return 'default';
    case 0x6e /* n */:
      return 'nothing';
    case 0x66 /* f */:
      return 'full';
    case 0x69 /* i */:
      return 'index';
    default:
      throw new WalDecodeError(null, `Relation message: unknown replica identity byte ${byte}.`);
  }
}

const STREAM_TAGS: Record<number, StreamMessage['kind']> = {
  0x53: 'start' /* S */,
  0x45: 'stop' /* E */,
  0x63: 'commit' /* c */,
  0x41: 'abort' /* A */,
};

export class PgoutputDecoder {
  private readonly relations = new Map<number, RelationMessage>();

  parse(buffer: Buffer): PgoutputMessage {
    const reader = new BinaryReader(buffer);
    const tag = reader.readUint8();
    switch (tag) {
      case 0x42 /* B */:
        return this.parseBegin(reader);
      case 0x43 /* C */:
        return this.parseCommit(reader);
      case 0x4f /* O */:
        return this.parseOrigin(reader);
      case 0x59 /* Y */:
        return this.parseType(reader);
      case 0x52 /* R */:
        return this.parseRelation(reader);
      case 0x49 /* I */:
        return this.parseInsert(reader);
      case 0x55 /* U */:
        return this.parseUpdate(reader);
      case 0x44 /* D */:
        return this.parseDelete(reader);
      case 0x54 /* T */:
        return this.parseTruncate(reader);
      case 0x4d /* M */:
        return { tag: 'message' };
      default: {
        const kind = STREAM_TAGS[tag];
        if (kind) return { tag: 'stream', kind };
        throw new WalDecodeError(null, `Unknown pgoutput message tag 0x${tag.toString(16)}.`);
      }
    }
  }

  private parseBegin(reader: BinaryReader): BeginMessage {
    return {
      tag: 'begin',
      commitLsn: reader.readLsn(),
      commitTime: reader.readTime(),
      xid: reader.readUint32(),
    };
  }

  private parseCommit(reader: BinaryReader): CommitMessage {
    reader.readUint8(); // flags, reserved
    const commitLsn = reader.readLsn();
    const commitEndLsn = reader.readLsn();
    return { tag: 'commit', commitLsn, commitEndLsn, commitTime: reader.readTime() };
  }

  private parseOrigin(reader: BinaryReader): OriginMessage {
    return { tag: 'origin', originLsn: reader.readLsn(), originName: reader.readString() };
  }

  private parseType(reader: BinaryReader): TypeMessage {
    return {
      tag: 'type',
      typeOid: reader.readUint32(),
      typeSchema: reader.readString(),
      typeName: reader.readString(),
    };
  }

  private parseRelation(reader: BinaryReader): RelationMessage {
    const relationOid = reader.readUint32();
    const schema = reader.readString();
    const name = reader.readString();
    const replicaIdentity = decodeReplicaIdentity(reader.readUint8());
    const columnCount = reader.readInt16();
    const columns: RelationColumn[] = [];
    for (let i = 0; i < columnCount; i++) {
      const flags = reader.readUint8();
      const colName = reader.readString();
      const typeOid = reader.readUint32();
      reader.readInt32(); // atttypmod, unused
      columns.push({ name: colName, typeOid, isKey: (flags & 0b1) === 1 });
    }
    const message: RelationMessage = {
      tag: 'relation',
      relationOid,
      schema,
      name,
      replicaIdentity,
      columns,
    };
    this.relations.set(relationOid, message);
    return message;
  }

  private requireRelation(oid: number): RelationMessage {
    const relation = this.relations.get(oid);
    if (!relation) {
      throw new WalDecodeError(
        null,
        `Received a row change for relation oid ${oid} before any Relation message described it.`,
      );
    }
    return relation;
  }

  private readTuple(reader: BinaryReader, relation: RelationMessage): RawTuple {
    const fieldCount = reader.readInt16();
    const tuple: RawTuple = {};
    for (let i = 0; i < fieldCount; i++) {
      const column = relation.columns[i];
      const kind = reader.readUint8();
      switch (kind) {
        case 0x74 /* t: text */: {
          const len = reader.readInt32();
          const raw = reader.readBytes(len);
          if (column) tuple[column.name] = textDecoder.decode(raw);
          break;
        }
        case 0x6e /* n: null */:
          if (column) tuple[column.name] = null;
          break;
        case 0x75 /* u: unchanged TOAST */:
          if (column) tuple[column.name] = TOAST_UNCHANGED;
          break;
        case 0x62 /* b: binary */:
          throw new WalDecodeError(
            relation.name,
            'Received a binary-format column value; this leader only requests text format.',
          );
        default:
          throw new WalDecodeError(
            relation.name,
            `Unknown tuple field kind 0x${kind.toString(16)}.`,
          );
      }
    }
    return tuple;
  }

  private readKeyTuple(reader: BinaryReader, relation: RelationMessage): RawTuple {
    const full = this.readTuple(reader, relation);
    const key: RawTuple = {};
    for (const col of relation.columns) {
      if (col.isKey && col.name in full) key[col.name] = full[col.name]!;
    }
    return key;
  }

  private parseInsert(reader: BinaryReader): InsertMessage {
    const relation = this.requireRelation(reader.readUint32());
    reader.readUint8(); // 'N' tuple marker
    return {
      tag: 'insert',
      relationOid: relation.relationOid,
      new: this.readTuple(reader, relation),
    };
  }

  private parseUpdate(reader: BinaryReader): UpdateMessage {
    const relation = this.requireRelation(reader.readUint32());
    const sub = reader.readUint8();
    let key: RawTuple | null = null;
    let old: RawTuple | null = null;
    let newTuple: RawTuple;
    if (sub === 0x4b /* K */) {
      key = this.readKeyTuple(reader, relation);
      reader.readUint8(); // 'N'
      newTuple = this.readTuple(reader, relation);
    } else if (sub === 0x4f /* O */) {
      old = this.readTuple(reader, relation);
      reader.readUint8(); // 'N'
      newTuple = this.readTuple(reader, relation);
    } else if (sub === 0x4e /* N */) {
      newTuple = this.readTuple(reader, relation);
    } else {
      throw new WalDecodeError(
        relation.name,
        `Update message: unknown submessage kind 0x${sub.toString(16)}.`,
      );
    }
    return { tag: 'update', relationOid: relation.relationOid, key, old, new: newTuple };
  }

  private parseDelete(reader: BinaryReader): DeleteMessage {
    const relation = this.requireRelation(reader.readUint32());
    const sub = reader.readUint8();
    let key: RawTuple | null = null;
    let old: RawTuple | null = null;
    if (sub === 0x4b /* K */) {
      key = this.readKeyTuple(reader, relation);
    } else if (sub === 0x4f /* O */) {
      old = this.readTuple(reader, relation);
    } else {
      throw new WalDecodeError(
        relation.name,
        `Delete message: unknown submessage kind 0x${sub.toString(16)}.`,
      );
    }
    return { tag: 'delete', relationOid: relation.relationOid, key, old };
  }

  private parseTruncate(reader: BinaryReader): TruncateMessage {
    const count = reader.readInt32();
    const flags = reader.readUint8();
    const relationOids: number[] = [];
    for (let i = 0; i < count; i++) relationOids.push(reader.readUint32());
    return {
      tag: 'truncate',
      cascade: (flags & 0b1) !== 0,
      restartIdentity: (flags & 0b10) !== 0,
      relationOids,
    };
  }

  relationFor(oid: number): RelationMessage | undefined {
    return this.relations.get(oid);
  }
}
