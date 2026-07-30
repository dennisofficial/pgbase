import { randomBytes } from 'node:crypto';
import { OID } from '../query/compare.js';
import type { ResolvedField, ResolvedModel } from '../schema/types.js';
import { PolicyValidationError } from './errors.js';
import type { Exposure, ProbeResult, Prober } from './types.js';

interface Sentinel {
  readonly value: unknown;
  readonly text: string;
}

const OPEN = '⟪';
const CLOSE = '⟫';

class SentinelGenerator {
  private counter = 0;
  private readonly salt: string;

  constructor(private readonly run: 1 | 2) {
    this.salt = randomBytes(8).toString('hex');
  }

  forField(model: ResolvedModel, field: ResolvedField): Sentinel {
    const id = ++this.counter;
    if (field.elementTypeOid !== null) {
      const inner = this.byOid(model, field, field.elementTypeOid, id);
      return { value: [inner.value], text: inner.text };
    }
    return this.byOid(model, field, field.typeOid, id);
  }

  private byOid(model: ResolvedModel, field: ResolvedField, oid: number, id: number): Sentinel {
    if (field.enumName !== null || field.isCitext) return this.text(id);
    switch (oid) {
      case OID.BOOL:
        return { value: true, text: 'true' };
      case OID.TEXT:
      case OID.VARCHAR:
      case OID.BPCHAR:
        return this.text(id);
      case OID.UUID:
        return this.uuid(id);
      case OID.INT8:
        return this.int8(id);
      case OID.INT2:
      case OID.INT4:
        return this.int(id);
      case OID.FLOAT4:
      case OID.FLOAT8:
        return this.float(id);
      case OID.NUMERIC:
        return this.numeric(id);
      case OID.TIMESTAMPTZ:
      case OID.TIMESTAMP:
        return this.timestampMicros(id);
      case OID.DATE:
        return this.date(id);
      case OID.JSON:
      case OID.JSONB:
        return this.json(id);
      default:
        throw new PolicyValidationError(
          `Model "${model.model}", field "${field.name}": the sentinel probe has no synthetic ` +
            `value for pg_type oid ${oid} (${field.typeName}). This is a gap in sentinel.ts, not ` +
            `a problem with the model — add a case, or keep this column out of a client-accessible ` +
            `model's transform for now.`,
        );
    }
  }

  private text(id: number): Sentinel {
    const t = `${OPEN}${this.salt}:${this.run}:${id}${CLOSE}`;
    return { value: t, text: t };
  }

  private uuid(id: number): Sentinel {
    // Not cryptographic — just needs to be well-formed (matches `UUID_RE` in compare.ts) and unique.
    const hex = `${this.salt}${this.run}${id}`.padEnd(32, '0').slice(0, 32);
    const v =
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-` +
      hex.slice(20, 32);
    return { value: v, text: v };
  }

  private int8(id: number): Sentinel {
    const base = BigInt(`0x${this.salt.slice(0, 8)}`);
    const v = BigInt(this.run) * 10_000_000_000_000n + base * 1000n + BigInt(id);
    return { value: v, text: v.toString() };
  }

  private int(id: number): Sentinel {
    // Kept small enough to stay in range for int2 columns too.
    const v = this.run * 10_000 + id;
    return { value: v, text: String(v) };
  }

  private float(id: number): Sentinel {
    const v = this.run * 10_000 + id + 0.5;
    return { value: v, text: String(v) };
  }

  private numeric(id: number): Sentinel {
    const frac = [...this.salt]
      .map((c) => parseInt(c, 16) % 10)
      .join('')
      .padEnd(6, '1')
      .slice(0, 6);
    const v = `${this.run * 100_000 + id}.${frac}`;
    return { value: v, text: v };
  }

  private timestampMicros(id: number): Sentinel {
    const base = 1_900_000_000_000_000n; // ~2030, arbitrary, just far from real defaults
    const v = base + BigInt(this.run) * 1_000_000_000n + BigInt(id) * 1_000_003n;
    return { value: v, text: v.toString() };
  }

  private date(id: number): Sentinel {
    const year = 2000 + ((this.run * 37 + id) % 50);
    const month = 1 + (id % 12);
    const day = 1 + (id % 28);
    const v = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return { value: v, text: v };
  }

  private json(id: number): Sentinel {
    const v = { __pgbaseSentinel: `${this.salt}:${this.run}:${id}` };
    return { value: v, text: JSON.stringify(v) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Output walking — plain objects/arrays are structure, everything else is a leaf.
// ─────────────────────────────────────────────────────────────────────────────

interface Walked {
  readonly paths: ReadonlySet<string>;
  readonly leaves: ReadonlyMap<string, unknown>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function walk(
  value: unknown,
  path: string,
  paths: Set<string>,
  leaves: Map<string, unknown>,
): void {
  if (path !== '') paths.add(path);
  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, `${path}[${i}]`, paths, leaves));
    return;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      walk(value[key], path ? `${path}.${key}` : key, paths, leaves);
    }
    return;
  }
  assertWireSerializable(value, path);
  if (path !== '') leaves.set(path, value);
}

function assertWireSerializable(value: unknown, path: string): void {
  if (value === null || value === undefined) return;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint') return;
  if (value instanceof Date) return;
  throw new PolicyValidationError(
    `transform() returned a non-serializable value at "${path || '<root>'}" ` +
      `(${value?.constructor?.name ?? t}). The view is sent as JSON; use plain objects, arrays, ` +
      `and primitives.`,
  );
}

function walkOutput(value: unknown): Walked {
  const paths = new Set<string>();
  const leaves = new Map<string, unknown>();
  walk(value, '', paths, leaves);
  return { paths, leaves };
}

function sentinelEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sentinelEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    return ak.length === bk.length && ak.every((k, i) => k === bk[i] && sentinelEqual(a[k], b[k]));
  }
  return false;
}

interface Classification {
  readonly exposure: Exposure;
  readonly path: string | null;
}

function classify(sentinel: Sentinel, walked: Walked): Classification {
  for (const [path, val] of walked.leaves) {
    if (sentinelEqual(val, sentinel.value)) return { exposure: 'whole', path };
    if (typeof val === 'string' && val === sentinel.text) return { exposure: 'whole', path };
  }
  for (const [path, val] of walked.leaves) {
    if (typeof val === 'string' && val !== sentinel.text && val.includes(sentinel.text)) {
      return { exposure: 'derived', path };
    }
  }
  return { exposure: 'absent', path: null };
}

/** Boolean co-variance: does any output path change when only this one column flips? */
function classifyBool(baseline: Walked, variant: Walked): Classification {
  const allPaths = [...new Set([...baseline.leaves.keys(), ...variant.leaves.keys()])].sort();
  for (const path of allPaths) {
    const inBase = baseline.leaves.has(path);
    const inVariant = variant.leaves.has(path);
    if (inBase !== inVariant) return { exposure: 'derived', path };
    const b = baseline.leaves.get(path);
    const v = variant.leaves.get(path);
    if (!sentinelEqual(b, v)) {
      if (typeof b === 'boolean' && typeof v === 'boolean') return { exposure: 'whole', path };
      return { exposure: 'derived', path };
    }
  }
  return { exposure: 'absent', path: null };
}

function assertSameShape(model: ResolvedModel, a: Walked, b: Walked): void {
  const onlyInA = [...a.paths].filter((p) => !b.paths.has(p));
  const onlyInB = [...b.paths].filter((p) => !a.paths.has(p));
  if (onlyInA.length === 0 && onlyInB.length === 0) return;
  throw new PolicyValidationError(
    `Model "${model.model}": transform's output shape differed between two probe runs given ` +
      `different (but equally valid) synthetic rows. transform must be pure and total — it must ` +
      `not branch on row VALUES, only ever produce the same set of output fields. Path(s) that ` +
      `appeared in only one run: ${[...new Set([...onlyInA, ...onlyInB])].sort().join(', ')}.`,
  );
}

function invoke(
  model: ResolvedModel,
  transform: (row: never) => unknown,
  row: Record<string, unknown>,
  label: string,
): unknown {
  try {
    return transform(row as never);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PolicyValidationError(
      `Model "${model.model}": transform threw while probing a synthetic row (${label}). ` +
        `transform must be pure and total over its own columns. Underlying error: ${message}`,
    );
  }
}

interface Row {
  readonly row: Record<string, unknown>;
  readonly sentinels: ReadonlyMap<string, Sentinel>;
}

function buildRow(
  model: ResolvedModel,
  otherFields: readonly ResolvedField[],
  boolFields: readonly ResolvedField[],
  gen: SentinelGenerator,
): Row {
  const row: Record<string, unknown> = {};
  const sentinels = new Map<string, Sentinel>();
  for (const field of otherFields) {
    const s = gen.forField(model, field);
    sentinels.set(field.name, s);
    row[field.name] = s.value;
  }
  for (const field of boolFields) row[field.name] = false;
  return { row, sentinels };
}

export function probe(model: ResolvedModel, transform: (row: never) => unknown): ProbeResult {
  const boolFields = model.fields.filter(
    (f) => f.elementTypeOid === null && f.typeOid === OID.BOOL,
  );
  const otherFields = model.fields.filter((f) => !boolFields.includes(f));

  const runA = buildRow(model, otherFields, boolFields, new SentinelGenerator(1));
  const runB = buildRow(model, otherFields, boolFields, new SentinelGenerator(2));

  const outputA = invoke(model, transform, runA.row, 'determinism check, pass 1');
  const outputB = invoke(model, transform, runB.row, 'determinism check, pass 2');
  const walkedA = walkOutput(outputA);
  const walkedB = walkOutput(outputB);
  assertSameShape(model, walkedA, walkedB);

  const exposure = new Map<string, Exposure>();
  const viewPaths = new Map<string, string>();

  for (const field of otherFields) {
    const classA = classify(runA.sentinels.get(field.name)!, walkedA);
    const classB = classify(runB.sentinels.get(field.name)!, walkedB);
    if (classA.exposure !== classB.exposure) {
      throw new PolicyValidationError(
        `Model "${model.model}", field "${field.name}": exposure differed between the two probe ` +
          `runs (${classA.exposure} vs ${classB.exposure}) — its presence in the output depends ` +
          `on this column's VALUE, not just its presence on the row. transform must be pure and ` +
          `total.`,
      );
    }
    exposure.set(field.name, classA.exposure);
    if (classA.exposure === 'whole' && classA.path) viewPaths.set(classA.path, field.name);
  }

  for (const field of boolFields) {
    const variantRow = { ...runA.row, [field.name]: true };
    const variantOutput = invoke(
      model,
      transform,
      variantRow,
      `boolean co-variance ("${field.name}")`,
    );
    const { exposure: exp, path } = classifyBool(walkedA, walkOutput(variantOutput));
    exposure.set(field.name, exp);
    if (exp === 'whole' && path) viewPaths.set(path, field.name);
  }

  const filterable = new Set<string>();
  for (const [name, exp] of exposure) if (exp === 'whole') filterable.add(name);

  return { model: model.model, exposure, viewPaths, filterable };
}

export const sentinelProber: Prober = { probe };
