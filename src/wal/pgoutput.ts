import { BinaryReader, textDecoder } from './binary-reader.js';
import {
  TOAST_UNCHANGED,
  type BeginMessage,
  type CommitMessage,
  type DeleteMessage,
  type InsertMessage,
  type OriginMessage,
  type PgoutputMessage,
  type RawTuple,
  type RelationColumn,
  type RelationMessage,
  type ReplicaIdentityWire,
  type StreamMessage,
  type TruncateMessage,
  type TypeMessage,
  type UpdateMessage,
} from './pgoutput-messages.js';
import { WalDecodeError } from './types.js';

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

  relationFor(oid: number): RelationMessage | undefined {
    return this.relations.get(oid);
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
    let prior: PriorTuple = { key: null, old: null };
    if (sub !== 0x4e /* N */) {
      prior = this.readPriorTuple(reader, relation, sub, 'Update');
      reader.readUint8(); // 'N'
    }
    return {
      tag: 'update',
      relationOid: relation.relationOid,
      ...prior,
      new: this.readTuple(reader, relation),
    };
  }

  private parseDelete(reader: BinaryReader): DeleteMessage {
    const relation = this.requireRelation(reader.readUint32());
    const prior = this.readPriorTuple(reader, relation, reader.readUint8(), 'Delete');
    return { tag: 'delete', relationOid: relation.relationOid, ...prior };
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

  private readPriorTuple(
    reader: BinaryReader,
    relation: RelationMessage,
    sub: number,
    context: 'Update' | 'Delete',
  ): PriorTuple {
    if (sub === 0x4b /* K */) return { key: this.readKeyTuple(reader, relation), old: null };
    if (sub === 0x4f /* O */) return { key: null, old: this.readTuple(reader, relation) };
    throw new WalDecodeError(
      relation.name,
      `${context} message: unknown submessage kind 0x${sub.toString(16)}.`,
    );
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
}

interface PriorTuple {
  readonly key: RawTuple | null;
  readonly old: RawTuple | null;
}
