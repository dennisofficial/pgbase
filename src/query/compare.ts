import type { Comparator } from './ast.js';
import { QueryError } from './errors.js';

export const OID = {
  BOOL: 16,
  INT8: 20,
  INT2: 21,
  INT4: 23,
  TEXT: 25,
  JSON: 114,
  FLOAT4: 700,
  FLOAT8: 701,
  VARCHAR: 1043,
  BPCHAR: 1042,
  DATE: 1082,
  TIMESTAMP: 1114,
  TIMESTAMPTZ: 1184,
  NUMERIC: 1700,
  UUID: 2950,
  JSONB: 3802,
} as const;

const TEXT_OIDS = new Set<number>([OID.TEXT, OID.VARCHAR, OID.BPCHAR]);
const JSON_OIDS = new Set<number>([OID.JSON, OID.JSONB]);

export const JSON_NULL: unique symbol = Symbol('pgbase.jsonNull');

export function isTextOid(oid: number): boolean {
  return TEXT_OIDS.has(oid);
}

export function isJsonOid(oid: number): boolean {
  return JSON_OIDS.has(oid);
}

export function sqlTypeName(oid: number): string {
  switch (oid) {
    case OID.BOOL:
      return 'boolean';
    case OID.INT2:
      return 'int2';
    case OID.INT4:
      return 'int4';
    case OID.INT8:
      return 'int8';
    case OID.NUMERIC:
      return 'numeric';
    case OID.FLOAT4:
      return 'float4';
    case OID.FLOAT8:
      return 'float8';
    case OID.TEXT:
    case OID.VARCHAR:
    case OID.BPCHAR:
      return 'text';
    case OID.UUID:
      return 'uuid';
    case OID.DATE:
      return 'date';
    case OID.TIMESTAMP:
      return 'timestamp';
    case OID.TIMESTAMPTZ:
      return 'timestamptz';
    case OID.JSON:
    case OID.JSONB:
      return 'jsonb';
    default:
      throw new QueryError(
        `Unsupported column type (pg_type oid ${oid}); pgbase has no comparator for it.`,
      );
  }
}

export function asciiLower(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    out += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : s[i];
  }
  return out;
}

function textCompare(a: string, b: string): number {
  const ai = Array.from(a);
  const bi = Array.from(b);
  const len = Math.min(ai.length, bi.length);
  for (let i = 0; i < len; i++) {
    const ca = ai[i]!.codePointAt(0)!;
    const cb = bi[i]!.codePointAt(0)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return ai.length === bi.length ? 0 : ai.length < bi.length ? -1 : 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// numeric — exact decimal string comparison, no float coercion
// ─────────────────────────────────────────────────────────────────────────────

const NUMERIC_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;

interface ParsedNumeric {
  readonly negative: boolean;
  readonly intPart: string;
  readonly fracPart: string;
}

function parseNumeric(raw: string): ParsedNumeric {
  const m = NUMERIC_RE.exec(raw.trim());
  if (!m) throw new QueryError(`invalid numeric literal: ${JSON.stringify(raw)}`);
  const negative = raw.trim()[0] === '-';
  const [intPart, fracPart = ''] = m[1]!.split('.');
  return { negative, intPart: intPart ?? '', fracPart };
}

function isZeroMagnitude(p: ParsedNumeric): boolean {
  return /^0*$/.test(p.intPart) && /^0*$/.test(p.fracPart);
}

function compareNumericMagnitude(a: ParsedNumeric, b: ParsedNumeric): number {
  const ia = a.intPart.replace(/^0+(?=\d)/, '');
  const ib = b.intPart.replace(/^0+(?=\d)/, '');
  if (ia.length !== ib.length) return ia.length < ib.length ? -1 : 1;
  if (ia !== ib) return ia < ib ? -1 : 1;
  const width = Math.max(a.fracPart.length, b.fracPart.length);
  const fa = a.fracPart.padEnd(width, '0');
  const fb = b.fracPart.padEnd(width, '0');
  return fa === fb ? 0 : fa < fb ? -1 : 1;
}

function compareNumeric(a: string, b: string): number {
  const pa = parseNumeric(a);
  const pb = parseNumeric(b);
  const za = isZeroMagnitude(pa);
  const zb = isZeroMagnitude(pb);
  if (za && zb) return 0;
  const signA = za ? 1 : pa.negative ? -1 : 1;
  const signB = zb ? 1 : pb.negative ? -1 : 1;
  if (signA !== signB) return signA < signB ? -1 : 1;
  const mag = compareNumericMagnitude(pa, pb);
  return signA === 1 ? mag : -mag;
}

const TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}(?::?\d{2})?)?$/;

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return q * b !== a && a < 0n !== b < 0n ? q - 1n : q;
}

function floorMod(a: bigint, b: bigint): bigint {
  return a - floorDiv(a, b) * b;
}

export function parseTimestampMicros(input: string, expectTz: boolean): bigint {
  const m = TIMESTAMP_RE.exec(input.trim());
  if (!m)
    throw new QueryError(
      `invalid timestamp${expectTz ? 'tz' : ''} literal: ${JSON.stringify(input)}`,
    );
  const [, y, mo, d, h, mi, s, frac, tz] = m;
  if (expectTz && !tz) {
    throw new QueryError(
      `timestamptz literal is missing a timezone/offset: ${JSON.stringify(input)}`,
    );
  }
  if (!expectTz && tz) {
    throw new QueryError(
      `timestamp (no tz) literal must not carry an offset: ${JSON.stringify(input)}`,
    );
  }
  const microsFrac = frac ? BigInt(frac.padEnd(6, '0').slice(0, 6)) : 0n;
  const baseMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  let micros = BigInt(baseMs) * 1000n + microsFrac;

  if (tz && tz !== 'Z' && tz !== 'z') {
    const rest = tz.slice(1).replace(':', '');
    const offH = BigInt(rest.slice(0, 2));
    const offM = rest.length > 2 ? BigInt(rest.slice(2)) : 0n;
    const offMicros = offH * 3_600_000_000n + offM * 60_000_000n;
    micros -= tz[0] === '-' ? -offMicros : offMicros;
  }
  return micros;
}

export function formatTimestampParam(micros: bigint, withTz: boolean): string {
  const ms = floorDiv(micros, 1000n);
  const subMs = floorMod(micros, 1000n);
  const date = new Date(Number(ms));
  const y = date.getUTCFullYear().toString().padStart(4, '0');
  const mo = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = date.getUTCDate().toString().padStart(2, '0');
  const h = date.getUTCHours().toString().padStart(2, '0');
  const mi = date.getUTCMinutes().toString().padStart(2, '0');
  const s = date.getUTCSeconds().toString().padStart(2, '0');
  const fracMicros = BigInt(date.getUTCMilliseconds()) * 1000n + subMs;
  const frac = fracMicros.toString().padStart(6, '0');
  return `${y}-${mo}-${d}T${h}:${mi}:${s}.${frac}${withTz ? 'Z' : ''}`;
}

function coerceTimestamp(raw: unknown, expectTz: boolean, fieldLabel: string): bigint {
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'string') return parseTimestampMicros(raw, expectTz);
  if (raw instanceof Date) return BigInt(raw.getTime()) * 1000n;
  throw new QueryError(
    `Field "${fieldLabel}": expected a bigint (microseconds since epoch), an ISO timestamp string, or a Date.`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// jsonb / json — structural equality, key order and whitespace irrelevant
// ─────────────────────────────────────────────────────────────────────────────

function jsonEquals(a: unknown, b: unknown): boolean {
  if (a === JSON_NULL || b === JSON_NULL) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => jsonEquals(v, b[i]));
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao).sort();
    const bk = Object.keys(bo).sort();
    if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
    return ak.every((k) => jsonEquals(ao[k], bo[k]));
  }
  return a === b;
}

// ─────────────────────────────────────────────────────────────────────────────
// per-OID handlers — single source of truth for coercion AND comparison
// ─────────────────────────────────────────────────────────────────────────────

interface TypeHandler extends Comparator {
  coerce(raw: unknown, fieldLabel: string): unknown;
}

function fail(fieldLabel: string, expected: string): never {
  throw new QueryError(`Field "${fieldLabel}": expected ${expected}.`);
}

const boolHandler: TypeHandler = {
  coerce: (raw, label) => (typeof raw === 'boolean' ? raw : fail(label, 'a boolean')),
  compare: (a, b) => ((a as boolean) === (b as boolean) ? 0 : (a as boolean) ? 1 : -1),
  equals: (a, b) => a === b,
};

const intHandler: TypeHandler = {
  coerce: (raw, label) =>
    typeof raw === 'number' && Number.isInteger(raw) ? raw : fail(label, 'an integer'),
  compare: (a, b) => Math.sign((a as number) - (b as number)),
  equals: (a, b) => a === b,
};

const int8Handler: TypeHandler = {
  coerce: (raw, label) => {
    if (typeof raw === 'bigint') return raw;
    if (typeof raw === 'number' && Number.isInteger(raw)) return BigInt(raw);
    if (typeof raw === 'string' && /^[+-]?\d+$/.test(raw)) return BigInt(raw);
    return fail(label, 'a bigint, integer, or digit string');
  },
  compare: (a, b) => ((a as bigint) < (b as bigint) ? -1 : (a as bigint) > (b as bigint) ? 1 : 0),
  equals: (a, b) => a === b,
};

const numericHandler: TypeHandler = {
  coerce: (raw, label) => {
    const s = typeof raw === 'number' ? String(raw) : raw;
    if (typeof s !== 'string' || !NUMERIC_RE.test(s.trim())) {
      return fail(label, 'a decimal string');
    }
    return s;
  },
  compare: (a, b) => compareNumeric(a as string, b as string),
  equals: (a, b) => compareNumeric(a as string, b as string) === 0,
};

const floatHandler: TypeHandler = {
  coerce: (raw, label) => (typeof raw === 'number' ? raw : fail(label, 'a number')),
  compare: (a, b) => {
    const x = a as number;
    const y = b as number;
    if (Number.isNaN(x) && Number.isNaN(y)) return 0;
    if (Number.isNaN(x)) return 1; // Postgres sorts NaN after every other float value.
    if (Number.isNaN(y)) return -1;
    return x < y ? -1 : x > y ? 1 : 0;
  },
  equals: (a, b) => (Number.isNaN(a as number) && Number.isNaN(b as number)) || a === b,
};

const textHandler: TypeHandler = {
  coerce: (raw, label) => (typeof raw === 'string' ? raw : fail(label, 'a string')),
  compare: (a, b) => textCompare(a as string, b as string),
  equals: (a, b) => a === b,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const uuidHandler: TypeHandler = {
  coerce: (raw, label) => {
    if (typeof raw !== 'string' || !UUID_RE.test(raw)) return fail(label, 'a UUID string');
    return raw.toLowerCase();
  },
  compare: (a, b) => ((a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0),
  equals: (a, b) => a === b,
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const dateHandler: TypeHandler = {
  coerce: (raw, label) =>
    typeof raw === 'string' && DATE_RE.test(raw) ? raw : fail(label, 'a "YYYY-MM-DD" date string'),
  compare: (a, b) => ((a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0),
  equals: (a, b) => a === b,
};

const timestamptzHandler: TypeHandler = {
  coerce: (raw, label) => coerceTimestamp(raw, true, label),
  compare: (a, b) => ((a as bigint) < (b as bigint) ? -1 : (a as bigint) > (b as bigint) ? 1 : 0),
  equals: (a, b) => a === b,
};

const timestampHandler: TypeHandler = {
  coerce: (raw, label) => coerceTimestamp(raw, false, label),
  compare: (a, b) => ((a as bigint) < (b as bigint) ? -1 : (a as bigint) > (b as bigint) ? 1 : 0),
  equals: (a, b) => a === b,
};

// ─────────────────────────────────────────────────────────────────────────────
// enum — ordered by DECLARATION index, never by text. Postgres enums sort by the order the
// labels were declared in, which routinely disagrees with lexical order (e.g. job_status:
// QUEUED < RUNNING < DONE < FAILED, where 'RUNNING' > 'FAILED' as text). Enum oids are
// per-install, so this is reached via `ResolvedField.enumValues`, never a `typeOid` switch.
// ─────────────────────────────────────────────────────────────────────────────

function enumIndex(values: readonly string[], v: unknown, label: string): number {
  const i = values.indexOf(v as string);
  if (i === -1) {
    throw new QueryError(
      `Field "${label}": ${JSON.stringify(v)} is not a member of this enum. Valid values: ` +
        `${values.join(', ')}.`,
    );
  }
  return i;
}

function enumHandler(values: readonly string[]): TypeHandler {
  return {
    coerce: (raw, label) => {
      if (typeof raw !== 'string') return fail(label, 'a string');
      enumIndex(values, raw, label);
      return raw;
    },
    compare: (a, b) => Math.sign(enumIndex(values, a, '') - enumIndex(values, b, '')),
    equals: (a, b) => a === b,
  };
}

const jsonHandler: TypeHandler = {
  coerce: (raw, label) => {
    if (raw === JSON_NULL) return raw;
    if (raw === null || raw === undefined || typeof raw === 'function') {
      return fail(
        label,
        'a JSON-serializable value (use the JSON_NULL sentinel for a stored JSON null)',
      );
    }
    return raw;
  },
  compare: () => {
    throw new QueryError('json/jsonb columns do not support ordering comparisons.');
  },
  equals: (a, b) => jsonEquals(a, b),
};

const HANDLERS = new Map<number, TypeHandler>([
  [OID.BOOL, boolHandler],
  [OID.INT2, intHandler],
  [OID.INT4, intHandler],
  [OID.INT8, int8Handler],
  [OID.NUMERIC, numericHandler],
  [OID.FLOAT4, floatHandler],
  [OID.FLOAT8, floatHandler],
  [OID.TEXT, textHandler],
  [OID.VARCHAR, textHandler],
  [OID.BPCHAR, textHandler],
  [OID.UUID, uuidHandler],
  [OID.DATE, dateHandler],
  [OID.TIMESTAMPTZ, timestamptzHandler],
  [OID.TIMESTAMP, timestampHandler],
  [OID.JSON, jsonHandler],
  [OID.JSONB, jsonHandler],
]);

function handlerFor(oid: number, enumValues: readonly string[] | null): TypeHandler {
  if (enumValues !== null) return enumHandler(enumValues);
  const h = HANDLERS.get(oid);
  if (!h)
    throw new QueryError(
      `Unsupported column type (pg_type oid ${oid}); pgbase has no comparator for it.`,
    );
  return h;
}

function arrayComparator(element: Comparator): Comparator {
  return {
    equals(a, b) {
      const av = a as readonly unknown[];
      const bv = b as readonly unknown[];
      return av.length === bv.length && av.every((v, i) => element.equals(v, bv[i]));
    },
    compare(a, b) {
      const av = a as readonly unknown[];
      const bv = b as readonly unknown[];
      const len = Math.min(av.length, bv.length);
      for (let i = 0; i < len; i++) {
        const c = element.compare(av[i], bv[i]);
        if (c !== 0) return c;
      }
      return av.length === bv.length ? 0 : av.length < bv.length ? -1 : 1;
    },
  };
}

export function getComparator(
  typeOid: number,
  elementTypeOid: number | null,
  enumValues: readonly string[] | null = null,
): Comparator {
  if (elementTypeOid !== null) return arrayComparator(handlerFor(elementTypeOid, enumValues));
  return handlerFor(typeOid, enumValues);
}

export function coerceValue(
  typeOid: number,
  elementTypeOid: number | null,
  raw: unknown,
  fieldLabel: string,
  enumValues: readonly string[] | null = null,
): unknown {
  if (elementTypeOid !== null) {
    if (!Array.isArray(raw)) return fail(fieldLabel, 'an array');
    const eh = handlerFor(elementTypeOid, enumValues);
    return raw.map((el) => {
      if (el === null)
        throw new QueryError(`Field "${fieldLabel}": array elements cannot be null.`);
      return eh.coerce(el, fieldLabel);
    });
  }
  return handlerFor(typeOid, enumValues).coerce(raw, fieldLabel);
}

export function formatParamText(oid: number, value: unknown, isEnum = false): string {
  if (isEnum) return value as string;
  switch (oid) {
    case OID.BOOL:
      return value ? 'true' : 'false';
    case OID.INT2:
    case OID.INT4:
    case OID.FLOAT4:
    case OID.FLOAT8:
      return String(value);
    case OID.INT8:
      return (value as bigint).toString();
    case OID.NUMERIC:
    case OID.TEXT:
    case OID.VARCHAR:
    case OID.BPCHAR:
    case OID.UUID:
    case OID.DATE:
      return value as string;
    case OID.TIMESTAMPTZ:
      return formatTimestampParam(value as bigint, true);
    case OID.TIMESTAMP:
      return formatTimestampParam(value as bigint, false);
    case OID.JSON:
    case OID.JSONB:
      return value === JSON_NULL ? 'null' : JSON.stringify(value);
    default:
      throw new QueryError(
        `Unsupported column type (pg_type oid ${oid}); pgbase has no comparator for it.`,
      );
  }
}

/** Postgres array-literal text (`{a,b,c}`), each element quoted/escaped unconditionally. */
export function formatArrayLiteral(
  elementOid: number,
  values: readonly unknown[],
  isEnum = false,
): string {
  const parts = values.map((v) => {
    const text = formatParamText(elementOid, v, isEnum);
    // A NULL element is the bare word NULL; quoting it would store the 4-character string "NULL".
    if (text === null) return 'NULL';
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  });
  return `{${parts.join(',')}}`;
}
