import type { Pool } from 'pg';
import { OID } from '../../query/compare.js';
import { compileSql } from '../../query/compile-sql.js';
import { normalize } from '../../query/normalize.js';
import type { ResolvedModel } from '../../schema/types.js';
import type { PgbasePrismaClient } from '../types.js';

export class FakeDecimal {
  readonly s = 1;
  readonly e = 0;
  readonly d = [0];
  constructor(private readonly text: string) {}
  toFixed(): string {
    return this.text;
  }
}

function decodeRow(row: Record<string, unknown>, model: ResolvedModel): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of model.fields) {
    const raw = row[field.column];
    if (raw === null || raw === undefined) {
      out[field.name] = raw ?? null;
    } else if (field.typeOid === OID.INT8) {
      out[field.name] = BigInt(raw as string);
    } else if (field.typeOid === OID.NUMERIC) {
      out[field.name] = new FakeDecimal(raw as string);
    } else {
      out[field.name] = raw;
    }
  }
  return out;
}

export function createFakePrisma(pool: Pool, model: ResolvedModel): PgbasePrismaClient {
  const delegate = model.model[0]!.toLowerCase() + model.model.slice(1);
  const allFields = new Set(model.fields.map((f) => f.name));

  async function findMany(args: { where?: unknown; take?: number } = {}): Promise<unknown[]> {
    const predicate = normalize((args.where ?? {}) as any, model, allFields);
    const { text, values } = compileSql(predicate);
    const limit = typeof args.take === 'number' ? ` LIMIT ${Math.trunc(args.take)}` : '';
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT * FROM "${model.table}" WHERE ${text}${limit}`,
      [...values],
    );
    return rows.map((row) => decodeRow(row, model));
  }

  const tx = { $executeRawUnsafe: async () => undefined, [delegate]: { findMany } };
  return {
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    $executeRawUnsafe: async () => undefined,
    [delegate]: { findMany },
  } as unknown as PgbasePrismaClient;
}
