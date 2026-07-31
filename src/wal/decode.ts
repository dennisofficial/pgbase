import { JSON_NULL, OID, parseTimestampMicros } from '../query/compare.js';
import type { ResolvedField, ResolvedModel } from '../schema/types.js';
import {
  TOAST_UNCHANGED,
  type DeleteMessage,
  type InsertMessage,
  type RawTuple,
  type UpdateMessage,
} from './pgoutput-messages.js';
import { WalDecodeError, type ColumnRow } from './types.js';

function floorToMillis(micros: bigint): bigint {
  const remainder = micros % 1000n;
  if (remainder === 0n) return micros;
  return micros - (remainder < 0n ? remainder + 1000n : remainder);
}

export function parsePgArrayLiteral(text: string, relation: string | null): (string | null)[] {
  if (text.length < 2 || text[0] !== '{' || text[text.length - 1] !== '}') {
    throw new WalDecodeError(
      relation,
      `Malformed array literal on the wire: ${JSON.stringify(text)}`,
    );
  }
  const out: (string | null)[] = [];
  let i = 1;
  const n = text.length - 1; // stop before the closing '}'
  if (i === n) return out; // "{}"
  for (;;) {
    if (text[i] === '"') {
      i++;
      let s = '';
      while (text[i] !== '"') {
        if (i >= n)
          throw new WalDecodeError(
            relation,
            `Unterminated quoted array element: ${JSON.stringify(text)}`,
          );
        if (text[i] === '\\') {
          i++;
          s += text[i];
        } else {
          s += text[i];
        }
        i++;
      }
      i++; // consume closing quote
      out.push(s);
    } else {
      let s = '';
      while (i < n && text[i] !== ',') {
        s += text[i];
        i++;
      }
      out.push(s === 'NULL' ? null : s);
    }
    if (text[i] === ',') {
      i++;
      continue;
    }
    if (i === n) break;
    throw new WalDecodeError(
      relation,
      `Malformed array literal on the wire: ${JSON.stringify(text)}`,
    );
  }
  return out;
}

function decodeScalar(typeOid: number, raw: string, relation: string | null): unknown {
  switch (typeOid) {
    case OID.BOOL:
      return raw === 't';
    case OID.INT2:
    case OID.INT4:
    case OID.FLOAT4:
    case OID.FLOAT8:
      return Number(raw);
    case OID.INT8:
      return BigInt(raw);
    case OID.NUMERIC:
    case OID.TEXT:
    case OID.VARCHAR:
    case OID.BPCHAR:
    case OID.DATE:
      return raw;
    case OID.UUID:
      return raw.toLowerCase();
    case OID.TIMESTAMPTZ:
      return floorToMillis(parseTimestampMicros(raw, true));
    case OID.TIMESTAMP:
      return floorToMillis(parseTimestampMicros(raw, false));
    case OID.JSON:
    case OID.JSONB: {
      const parsed: unknown = JSON.parse(raw);
      return parsed === null ? JSON_NULL : parsed;
    }
    default:
      throw new WalDecodeError(relation, `No WAL decoder for pg_type oid ${typeOid}.`);
  }
}

export function decodeColumn(
  field: ResolvedField,
  raw: string,
  relation: string | null = null,
): unknown {
  if (field.elementTypeOid !== null) {
    return parsePgArrayLiteral(raw, relation).map((el) => {
      if (el === null) return null;
      if (field.enumValues !== null) return el;
      if (field.isCitext) return el;
      return decodeScalar(field.elementTypeOid!, el, relation);
    });
  }
  if (field.enumValues !== null) return raw;
  if (field.isCitext) return raw;
  return decodeScalar(field.typeOid, raw, relation);
}

export interface DecodedChange {
  readonly newRow: ColumnRow | null;
  readonly oldRow: ColumnRow | null;
  readonly unknownColumns: ReadonlySet<string>;
}

function decodeFullTuple(
  model: ResolvedModel,
  raw: RawTuple,
  toastFallback: RawTuple | null,
  unknown: Set<string>,
): ColumnRow {
  const row: ColumnRow = {};
  for (const field of model.fields) {
    const v = raw[field.column];
    if (v === undefined) {
      unknown.add(field.column);
      continue;
    }
    if (v === TOAST_UNCHANGED) {
      const fb = toastFallback?.[field.column];
      if (fb !== undefined && fb !== TOAST_UNCHANGED) {
        row[field.column] = fb === null ? null : decodeColumn(field, fb, model.table);
      } else {
        unknown.add(field.column);
      }
      continue;
    }
    row[field.column] = v === null ? null : decodeColumn(field, v, model.table);
  }
  return row;
}

function decodeKeyOnlyRow(model: ResolvedModel, rawKey: RawTuple): ColumnRow {
  const row: ColumnRow = {};
  for (const [column, v] of Object.entries(rawKey)) {
    const field = model.byColumn.get(column);
    if (!field || v === undefined || v === TOAST_UNCHANGED) continue;
    row[column] = v === null ? null : decodeColumn(field, v, model.table);
  }
  return row;
}

function synthesizeKeyRow(model: ResolvedModel, newRow: ColumnRow): ColumnRow {
  const row: ColumnRow = {};
  for (const column of model.primaryKey) {
    if (column in newRow) row[column] = newRow[column];
  }
  return row;
}

export function decodeInsert(model: ResolvedModel, msg: InsertMessage): DecodedChange {
  const unknown = new Set<string>();
  const newRow = decodeFullTuple(model, msg.new, null, unknown);
  return { newRow, oldRow: null, unknownColumns: unknown };
}

export function decodeUpdate(model: ResolvedModel, msg: UpdateMessage): DecodedChange {
  const unknown = new Set<string>();
  const newRow = decodeFullTuple(model, msg.new, msg.old, unknown);
  const oldRow = msg.old
    ? decodeFullTuple(model, msg.old, null, unknown)
    : msg.key
      ? decodeKeyOnlyRow(model, msg.key)
      : synthesizeKeyRow(model, newRow);
  return { newRow, oldRow, unknownColumns: unknown };
}

export function decodeDelete(model: ResolvedModel, msg: DeleteMessage): DecodedChange {
  const unknown = new Set<string>();
  const oldRow = msg.old
    ? decodeFullTuple(model, msg.old, null, unknown)
    : msg.key
      ? decodeKeyOnlyRow(model, msg.key)
      : {};
  return { newRow: null, oldRow, unknownColumns: unknown };
}
