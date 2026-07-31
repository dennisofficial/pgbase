import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AsyncLocalStorageContextStore, ScopeViolationError } from '../../context/index.js';
import { definePolicy } from '../../policy/define.js';
import { validatePolicies } from '../../policy/index.js';
import { createTestPool } from '../../schema/test-support.js';
import type { ResolvedModel } from '../../schema/types.js';
import { resolveSimpleModel, schemaOf } from '../../wal/__tests__/simple-model.js';
import { PgbaseScopedWriteService, ScopedRowNotFoundError } from '../scoped-write-service.js';

const TABLE = 'pgbase_scoped_widgets';

interface Claims {
  readonly tenant: string;
}

const widgetPolicy = definePolicy<
  { id: number; tenant: string; status: string; secret: string },
  Claims
>('ScopedWidget')({
  omit: ['secret'],
  rls: (claims) => ({ tenant: claims.tenant }),
});

function realPrisma(pool: Pool) {
  const where = (w: Record<string, unknown>) => {
    const keys = Object.keys(w);
    const text = keys.map((k, i) => `"${k}" = $${i + 1}`).join(' AND ');
    return { text: text || 'TRUE', values: keys.map((k) => w[k]) };
  };

  function delegateFor(exec: (sql: string, params: unknown[]) => Promise<any[]>) {
    return {
      async findFirst(args: { where?: any } = {}) {
        const flat = flatten(args.where ?? {});
        const { text, values } = where(flat);
        const rows = await exec(`SELECT * FROM "${TABLE}" WHERE ${text} LIMIT 1`, values);
        return rows[0] ?? null;
      },
      async create(args: { data: Record<string, unknown> }) {
        const keys = Object.keys(args.data);
        const cols = keys.map((k) => `"${k}"`).join(', ');
        const ph = keys.map((_, i) => `$${i + 1}`).join(', ');
        const rows = await exec(
          `INSERT INTO "${TABLE}" (${cols}) VALUES (${ph}) RETURNING *`,
          keys.map((k) => args.data[k]),
        );
        return rows[0];
      },
      async update(args: { where: any; data: Record<string, unknown> }) {
        const sets: string[] = [];
        const values: unknown[] = [];
        for (const [k, v] of Object.entries(args.data)) {
          if (v !== null && typeof v === 'object' && 'increment' in (v as object)) {
            sets.push(`"${k}" = "${k}" + $${values.length + 1}`);
            values.push((v as { increment: number }).increment);
          } else {
            sets.push(`"${k}" = $${values.length + 1}`);
            values.push(v);
          }
        }
        const w = where(args.where);
        const shifted = w.text.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + values.length}`);
        const rows = await exec(
          `UPDATE "${TABLE}" SET ${sets.join(', ')} WHERE ${shifted} RETURNING *`,
          [...values, ...w.values],
        );
        return rows[0];
      },
      async delete(args: { where: any }) {
        const w = where(args.where);
        const rows = await exec(`DELETE FROM "${TABLE}" WHERE ${w.text} RETURNING *`, w.values);
        return rows[0];
      },
    };
  }

  const poolExec = async (sql: string, params: unknown[]) => (await pool.query(sql, params)).rows;

  return {
    scopedWidget: delegateFor(poolExec),
    async $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      const client: PoolClient = await pool.connect();
      const txExec = async (sql: string, params: unknown[]) =>
        (await client.query(sql, params)).rows;
      try {
        await client.query('BEGIN');
        const out = await fn({
          scopedWidget: delegateFor(txExec),
          $executeRawUnsafe: async () => undefined,
        });
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
  } as any;
}

/** `scopedWhere` nests the RLS filter under AND; the fake client only speaks flat equality. */
function flatten(node: any): Record<string, unknown> {
  if (!node || typeof node !== 'object') return {};
  if (Array.isArray(node.AND)) return Object.assign({}, ...node.AND.map(flatten));
  return node;
}

let pool: Pool;
let model: ResolvedModel;
let service: PgbaseScopedWriteService;
let store: AsyncLocalStorageContextStore;

const ALICE: Claims = { tenant: 'tenant-a' };
const BOB: Claims = { tenant: 'tenant-b' };

async function as<T>(claims: Claims, fn: () => Promise<T>): Promise<T> {
  return store.run({ principal: claims.tenant, claims }, fn);
}

async function rowOf(id: number) {
  const { rows } = await pool.query(`SELECT * FROM "${TABLE}" WHERE id = $1`, [id]);
  return rows[0];
}

beforeAll(async () => {
  pool = createTestPool();
  await pool.query(`DROP TABLE IF EXISTS "${TABLE}"`);
  await pool.query(`
    CREATE TABLE "${TABLE}" (
      id integer PRIMARY KEY,
      tenant text NOT NULL,
      status text NOT NULL,
      priority integer NOT NULL DEFAULT 0,
      secret text NOT NULL
    )
  `);
  model = await resolveSimpleModel(pool, 'ScopedWidget', TABLE, [
    { name: 'id', required: true },
    { name: 'tenant', required: true },
    { name: 'status', required: true },
    { name: 'priority', required: true },
    { name: 'secret', required: true },
  ]);
  const schema = schemaOf(model, 'unused_publication');
  const policies = validatePolicies(schema, { ScopedWidget: widgetPolicy });

  store = new AsyncLocalStorageContextStore();
  service = new PgbaseScopedWriteService(
    { prisma: realPrisma(pool) } as any,
    { schema, policies } as any,
    store,
  );
}, 60_000);

beforeEach(async () => {
  await pool.query(`TRUNCATE "${TABLE}"`);
  await pool.query(
    `INSERT INTO "${TABLE}" VALUES (1, 'tenant-a', 'ACTIVE', 5, 'a-secret'),
                                  (2, 'tenant-b', 'ACTIVE', 5, 'b-secret')`,
  );
});

afterAll(async () => {
  if (pool) {
    await pool.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    await pool.end();
  }
});

describe('scoped writes derive authorization from the read policy', () => {
  it('updates a row the caller can see', async () => {
    await as(ALICE, () =>
      service.update('ScopedWidget', { where: { id: 1 }, data: { priority: { increment: 1 } } }),
    );
    expect((await rowOf(1)).priority).toBe(6);
  });

  it("refuses to update another tenant's row, and leaves it untouched", async () => {
    // The row exists. It is simply not this caller's, and the error must not say which.
    await expect(
      as(ALICE, () =>
        service.update('ScopedWidget', { where: { id: 2 }, data: { status: 'HACKED' } }),
      ),
    ).rejects.toBeInstanceOf(ScopedRowNotFoundError);
    expect((await rowOf(2)).status).toBe('ACTIVE');
  });

  it('rolls back an update that would move the row out of the caller scope', async () => {
    // Allowed to touch the row, not allowed to hand it to another tenant. The check runs after the
    // UPDATE — `{ increment }` and friends make the post-image unpredictable — so only a real
    // rollback keeps this from committing.
    await expect(
      as(ALICE, () =>
        service.update('ScopedWidget', { where: { id: 1 }, data: { tenant: 'tenant-b' } }),
      ),
    ).rejects.toBeInstanceOf(ScopeViolationError);
    expect((await rowOf(1)).tenant).toBe('tenant-a');
  });

  it("refuses to delete another tenant's row", async () => {
    await expect(
      as(ALICE, () => service.delete('ScopedWidget', { where: { id: 2 } })),
    ).rejects.toBeInstanceOf(ScopedRowNotFoundError);
    expect(await rowOf(2)).toBeDefined();
  });

  it('deletes a row the caller can see', async () => {
    await as(ALICE, () => service.delete('ScopedWidget', { where: { id: 1 } }));
    expect(await rowOf(1)).toBeUndefined();
  });

  it('refuses to create a row outside the caller scope', async () => {
    await expect(
      as(ALICE, () =>
        service.create('ScopedWidget', {
          data: { id: 3, tenant: 'tenant-b', status: 'ACTIVE', priority: 0, secret: 'x' },
        }),
      ),
    ).rejects.toBeInstanceOf(ScopeViolationError);
    expect(await rowOf(3)).toBeUndefined();
  });

  it('creates a row inside the caller scope', async () => {
    await as(BOB, () =>
      service.create('ScopedWidget', {
        data: { id: 4, tenant: 'tenant-b', status: 'ACTIVE', priority: 0, secret: 'x' },
      }),
    );
    expect((await rowOf(4)).tenant).toBe('tenant-b');
  });

  it('refuses to write with no request context at all', async () => {
    // A cron or queue worker has no caller to scope to, and must not silently get tenant-wide reach.
    await expect(
      service.update('ScopedWidget', { where: { id: 1 }, data: { status: 'X' } }),
    ).rejects.toThrow(/context/i);
  });
});
