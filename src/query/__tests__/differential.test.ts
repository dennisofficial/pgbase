import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPool } from '../../schema/test-support.js';
import type { ResolvedField, ResolvedModel } from '../../schema/types.js';
import type { PredicateNode } from '../ast.js';
import { JSON_NULL } from '../compare.js';
import { compileSql } from '../compile-sql.js';
import { evaluate } from '../evaluate.js';
import {
  ARR,
  DATE,
  ENUM_VALUES,
  F8,
  I8,
  JS,
  NUM,
  ROWS,
  STATUS,
  TABLE,
  TS,
  TSTZ,
  TXT,
  UUID_A,
  UUID_B,
  UUID_F,
  UUID_ZERO,
  createFixture,
  dropFixture,
  resolveFixtureModel,
} from './differential-fixture.js';

let pool: Pool;
let model: ResolvedModel;
let comparisons = 0;

beforeAll(async () => {
  pool = createTestPool();
  await createFixture(pool);
  model = await resolveFixtureModel(pool);
}, 60_000);

afterAll(async () => {
  await dropFixture(pool);
  await pool.end();
});

function field(name: string): ResolvedField {
  const f = model.byColumn.get(name);
  if (!f) throw new Error(`fixture: no column "${name}"`);
  return f;
}

function describeValue(v: unknown): unknown {
  if (typeof v === 'bigint') return `${v}n`;
  if (v === JSON_NULL) return '<JSON_NULL>';
  return v;
}

function describeNode(node: PredicateNode): unknown {
  return JSON.parse(
    JSON.stringify(node, (key, value) => {
      if (key === 'field' && value && typeof value === 'object')
        return `<field ${(value as ResolvedField).column}>`;
      if (typeof value === 'bigint') return `${value}n`;
      if (value === JSON_NULL) return '<JSON_NULL>';
      return value;
    }),
  );
}

/** Runs a single predicate through both interpreters and asserts row-by-row agreement, reporting
 * the exact (predicate, row) pair on the first divergence found. */
async function assertAgrees(node: PredicateNode): Promise<void> {
  const { text, values } = compileSql(node);
  const { rows: sqlRows } = await pool.query<{ id: number }>(
    `SELECT id FROM "${TABLE}" WHERE ${text}`,
    [...values],
  );
  const matched = new Set(sqlRows.map((r) => r.id));

  for (const row of ROWS) {
    comparisons++;
    const sqlSays = matched.has(row.id as number);
    const jsSays = evaluate(node, row);
    if (sqlSays !== jsSays) {
      const rowDump = Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k, describeValue(v)]),
      );
      throw new Error(
        `Divergence on row id=${row.id}\n` +
          `predicate: ${JSON.stringify(describeNode(node))}\n` +
          `SQL says matched=${sqlSays}, evaluate() says ${jsSays}\n` +
          `row: ${JSON.stringify(rowDump)}`,
      );
    }
  }
}

async function assertAllAgree(nodes: readonly PredicateNode[]): Promise<void> {
  for (const node of nodes) await assertAgrees(node);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-column, per-operator predicate generators
// ─────────────────────────────────────────────────────────────────────────────

function scalarPredicates(f: ResolvedField, pool_: readonly unknown[]): PredicateNode[] {
  const nodes: PredicateNode[] = [];
  for (const v of pool_) {
    nodes.push(
      { kind: 'compare', field: f, op: 'equals', value: v, insensitive: false },
      { kind: 'compare', field: f, op: 'not', value: v, insensitive: false },
      { kind: 'compare', field: f, op: 'lt', value: v, insensitive: false },
      { kind: 'compare', field: f, op: 'lte', value: v, insensitive: false },
      { kind: 'compare', field: f, op: 'gt', value: v, insensitive: false },
      { kind: 'compare', field: f, op: 'gte', value: v, insensitive: false },
    );
  }
  if (pool_.length >= 2) {
    nodes.push(
      { kind: 'set', field: f, op: 'in', values: pool_.slice(0, 3) },
      { kind: 'set', field: f, op: 'notIn', values: pool_.slice(0, 3) },
      { kind: 'set', field: f, op: 'in', values: [] },
      { kind: 'set', field: f, op: 'notIn', values: [] },
    );
  }
  nodes.push(
    { kind: 'isNull', field: f, negated: false },
    { kind: 'isNull', field: f, negated: true },
  );
  return nodes;
}

function boolPredicates(f: ResolvedField): PredicateNode[] {
  return [
    { kind: 'compare', field: f, op: 'equals', value: true, insensitive: false },
    { kind: 'compare', field: f, op: 'equals', value: false, insensitive: false },
    { kind: 'compare', field: f, op: 'not', value: true, insensitive: false },
    { kind: 'isNull', field: f, negated: false },
    { kind: 'isNull', field: f, negated: true },
  ];
}

function textPredicates(f: ResolvedField, pool_: readonly string[]): PredicateNode[] {
  const nodes = scalarPredicates(f, pool_);
  const needles = [TXT.a, TXT.percent, TXT.underscore, TXT.backslash, TXT.mixedCase, TXT.unicode];
  for (const needle of needles) {
    for (const op of ['contains', 'startsWith', 'endsWith'] as const) {
      nodes.push({ kind: 'compare', field: f, op, value: needle, insensitive: false });
      nodes.push({ kind: 'compare', field: f, op, value: needle, insensitive: true });
    }
    nodes.push({ kind: 'compare', field: f, op: 'equals', value: needle, insensitive: true });
    nodes.push({ kind: 'compare', field: f, op: 'not', value: needle, insensitive: true });
  }
  return nodes;
}

function jsonPredicates(f: ResolvedField, pool_: readonly unknown[]): PredicateNode[] {
  const nodes: PredicateNode[] = [];
  for (const v of pool_) {
    nodes.push(
      { kind: 'compare', field: f, op: 'equals', value: v, insensitive: false },
      { kind: 'compare', field: f, op: 'not', value: v, insensitive: false },
    );
  }
  nodes.push(
    { kind: 'isNull', field: f, negated: false },
    { kind: 'isNull', field: f, negated: true },
  );
  return nodes;
}

function listPredicates(f: ResolvedField, elementPool: readonly string[]): PredicateNode[] {
  const nodes: PredicateNode[] = [
    { kind: 'list', field: f, op: 'isEmpty', values: [] },
    { kind: 'not', child: { kind: 'list', field: f, op: 'isEmpty', values: [] } },
    { kind: 'compare', field: f, op: 'equals', value: ARR.ab, insensitive: false },
    { kind: 'compare', field: f, op: 'equals', value: ARR.empty, insensitive: false },
    { kind: 'compare', field: f, op: 'not', value: ARR.ab, insensitive: false },
    { kind: 'isNull', field: f, negated: false },
    { kind: 'isNull', field: f, negated: true },
  ];
  for (const v of elementPool) {
    nodes.push({ kind: 'list', field: f, op: 'has', values: [v] });
  }
  nodes.push(
    { kind: 'list', field: f, op: 'hasSome', values: ['a', 'x'] },
    { kind: 'list', field: f, op: 'hasEvery', values: ['a', 'b'] },
    { kind: 'list', field: f, op: 'hasSome', values: [] },
    { kind: 'list', field: f, op: 'hasEvery', values: [] },
  );
  return nodes;
}

function enumListPredicates(f: ResolvedField): PredicateNode[] {
  const nodes: PredicateNode[] = [
    { kind: 'list', field: f, op: 'isEmpty', values: [] },
    { kind: 'not', child: { kind: 'list', field: f, op: 'isEmpty', values: [] } },
    {
      kind: 'compare',
      field: f,
      op: 'equals',
      value: [STATUS.queued, STATUS.running],
      insensitive: false,
    },
    { kind: 'compare', field: f, op: 'equals', value: [] as readonly string[], insensitive: false },
    {
      kind: 'compare',
      field: f,
      op: 'not',
      value: [STATUS.queued, STATUS.running],
      insensitive: false,
    },
    { kind: 'isNull', field: f, negated: false },
    { kind: 'isNull', field: f, negated: true },
  ];
  for (const v of ENUM_VALUES) {
    nodes.push({ kind: 'list', field: f, op: 'has', values: [v] });
  }
  nodes.push(
    { kind: 'list', field: f, op: 'hasSome', values: [STATUS.running, STATUS.done] },
    { kind: 'list', field: f, op: 'hasEvery', values: [STATUS.queued, STATUS.running] },
    { kind: 'list', field: f, op: 'hasSome', values: [] },
    { kind: 'list', field: f, op: 'hasEvery', values: [] },
  );
  return nodes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Atomic operator coverage — every operator x every hazardous type
// ─────────────────────────────────────────────────────────────────────────────

describe('differential: atomic predicates, every operator x every type', () => {
  it('bool', async () => {
    await assertAllAgree(boolPredicates(field('c_bool')));
    await assertAllAgree(boolPredicates(field('c_bool_n')));
  });

  it('int4', async () => {
    const pool_ = [-7, 0, 5, 1000];
    await assertAllAgree(scalarPredicates(field('c_int4'), pool_));
    await assertAllAgree(scalarPredicates(field('c_int4_n'), pool_));
  });

  it('int8 — 2^53 neighbourhood, sign, and 64-bit extremes', async () => {
    const pool_ = [
      I8.zero,
      I8.one,
      I8.negOne,
      I8.safeMax,
      I8.safePlus1,
      I8.safePlus2,
      I8.safePlus3,
      I8.negSafePlus2,
      I8.int8Max,
      I8.int8Min,
    ];
    await assertAllAgree(scalarPredicates(field('c_int8'), pool_));
    await assertAllAgree(scalarPredicates(field('c_int8_n'), pool_));
  });

  it('numeric — trailing scale digits, sign, negative zero', async () => {
    const pool_ = [
      NUM.zero,
      NUM.negZero,
      NUM.one,
      NUM.onePlusEps,
      NUM.negOne,
      NUM.negOnePlusEps,
      NUM.small,
      NUM.negSmall,
      NUM.big,
    ];
    await assertAllAgree(scalarPredicates(field('c_numeric'), pool_));
    await assertAllAgree(scalarPredicates(field('c_numeric_n'), pool_));
  });

  it('float8', async () => {
    const pool_ = [F8.zero, F8.negOne5, F8.one5, F8.sum, F8.big];
    await assertAllAgree(scalarPredicates(field('c_float8'), pool_));
    await assertAllAgree(scalarPredicates(field('c_float8_n'), pool_));
  });

  it('uuid — case-normalized comparison', async () => {
    const pool_ = [UUID_A, UUID_B, UUID_ZERO, UUID_F, UUID_A.toUpperCase()];
    await assertAllAgree(scalarPredicates(field('c_uuid'), pool_));
    await assertAllAgree(scalarPredicates(field('c_uuid_n'), pool_));
  });

  it('date', async () => {
    const pool_ = [DATE.d1, DATE.d2, DATE.d3, DATE.d4];
    await assertAllAgree(scalarPredicates(field('c_date'), pool_));
    await assertAllAgree(scalarPredicates(field('c_date_n'), pool_));
  });

  it('timestamp (no tz) — 1 microsecond apart', async () => {
    const pool_ = [TS.base, TS.minus1us, TS.plus1us];
    await assertAllAgree(scalarPredicates(field('c_ts'), pool_));
    await assertAllAgree(scalarPredicates(field('c_ts_n'), pool_));
  });

  it('timestamptz — 1 microsecond apart', async () => {
    const pool_ = [TSTZ.base, TSTZ.minus1us, TSTZ.plus1us];
    await assertAllAgree(scalarPredicates(field('c_tstz'), pool_));
    await assertAllAgree(scalarPredicates(field('c_tstz_n'), pool_));
  });

  it('text — empty, LIKE metacharacters, unicode, case, contains/startsWith/endsWith, mode:insensitive', async () => {
    const pool_ = [
      TXT.empty,
      TXT.a,
      TXT.A,
      TXT.ab,
      TXT.percent,
      TXT.underscore,
      TXT.backslash,
      TXT.unicode,
      TXT.unicodeUpper,
      TXT.mixedCase,
      TXT.dup,
    ];
    await assertAllAgree(textPredicates(field('c_text'), pool_));
    await assertAllAgree(textPredicates(field('c_text_n'), pool_));
  });

  it('jsonb — structural equality, JSON null vs SQL null', async () => {
    const pool_ = [
      JS.emptyObj,
      JS.a1,
      JS.a2,
      JS.arr123,
      JS.str,
      JS.num,
      JS.bool,
      JS.nested,
      JS.jsonNull,
    ];
    await assertAllAgree(jsonPredicates(field('c_json'), pool_));
    await assertAllAgree(jsonPredicates(field('c_json_n'), pool_));
  });

  it('text[] — has/hasSome/hasEvery/isEmpty, empty and duplicate arrays', async () => {
    await assertAllAgree(listPredicates(field('c_arr'), ['a', 'b', 'x', '']));
    await assertAllAgree(listPredicates(field('c_arr_n'), ['a', 'b', 'x', '']));
  });

  // Native Postgres enum. `ENUM_VALUES` (QUEUED, RUNNING, DONE, FAILED) is declared in an order
  // that DISAGREES with text order on RUNNING/FAILED — the exact case a text-comparator
  // regression would flip. Covers every operator, a nullable column with NULLs, and enum arrays.
  it('enum — declaration order disagrees with text order (RUNNING/FAILED)', async () => {
    await assertAllAgree(scalarPredicates(field('c_enum'), [...ENUM_VALUES]));
    await assertAllAgree(scalarPredicates(field('c_enum_n'), [...ENUM_VALUES]));
  });

  it('enum[] — has/hasSome/hasEvery/isEmpty, whole-array equals', async () => {
    await assertAllAgree(enumListPredicates(field('c_enum_arr')));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Nested AND/OR/NOT, at least 3 deep, including NOT over a predicate on a NULL column
// ─────────────────────────────────────────────────────────────────────────────

describe('differential: nested boolean combinators', () => {
  const int8 = () => field('c_int8');
  const int8n = () => field('c_int8_n');
  const text = () => field('c_text');
  const arr = () => field('c_arr');

  it('AND of comparisons across columns', async () => {
    await assertAgrees({
      kind: 'and',
      children: [
        { kind: 'compare', field: int8(), op: 'gt', value: I8.zero, insensitive: false },
        { kind: 'compare', field: text(), op: 'contains', value: TXT.a, insensitive: false },
      ],
    });
  });

  it('OR of comparisons across columns', async () => {
    await assertAgrees({
      kind: 'or',
      children: [
        { kind: 'compare', field: int8(), op: 'equals', value: I8.zero, insensitive: false },
        { kind: 'list', field: arr(), op: 'has', values: ['x'] },
      ],
    });
  });

  it('NOT over a comparison on a nullable column (some rows NULL, some not)', async () => {
    await assertAgrees({
      kind: 'not',
      child: { kind: 'compare', field: int8n(), op: 'equals', value: I8.one, insensitive: false },
    });
  });

  it('NOT over isNull on a nullable column', async () => {
    await assertAgrees({ kind: 'not', child: { kind: 'isNull', field: int8n(), negated: false } });
  });

  it('NOT over an enum comparison on a nullable column (some rows NULL, some not)', async () => {
    const enumN = () => field('c_enum_n');
    await assertAgrees({
      kind: 'not',
      child: {
        kind: 'compare',
        field: enumN(),
        op: 'equals',
        value: STATUS.failed,
        insensitive: false,
      },
    });
    await assertAgrees({
      kind: 'not',
      child: {
        kind: 'compare',
        field: enumN(),
        op: 'gt',
        value: STATUS.queued,
        insensitive: false,
      },
    });
  });

  // `has` compiles to `= ANY(col)`, which propagates NULL through a stored NULL *element*: a
  // non-match is unknown, not false. Only observable under NOT — unnegated, unknown and false
  // both just exclude the row. `hasSome`/`hasEvery` (`&&`/`@>`) do NOT propagate; they are here
  // to pin that asymmetry so a future "simplification" cannot quietly align them.
  it('NOT over list ops on an array containing a NULL element', async () => {
    for (const op of ['has', 'hasSome', 'hasEvery'] as const) {
      for (const needle of ['a', 'x', '']) {
        await assertAgrees({
          kind: 'not',
          child: { kind: 'list', field: arr(), op, values: [needle] },
        });
      }
    }
  });

  it('3-deep: NOT(AND(a, OR(b, NOT(c))))', async () => {
    const a: PredicateNode = {
      kind: 'compare',
      field: int8(),
      op: 'gte',
      value: I8.zero,
      insensitive: false,
    };
    const b: PredicateNode = {
      kind: 'compare',
      field: text(),
      op: 'startsWith',
      value: TXT.a,
      insensitive: false,
    };
    const c: PredicateNode = {
      kind: 'compare',
      field: int8n(),
      op: 'lt',
      value: I8.zero,
      insensitive: false,
    };
    await assertAgrees({
      kind: 'not',
      child: {
        kind: 'and',
        children: [a, { kind: 'or', children: [b, { kind: 'not', child: c }] }],
      },
    });
  });

  it('4-deep: AND(OR(NOT(AND(a,b)), c), NOT(isNull))', async () => {
    const a: PredicateNode = {
      kind: 'compare',
      field: int8(),
      op: 'gt',
      value: I8.negOne,
      insensitive: false,
    };
    const b: PredicateNode = {
      kind: 'compare',
      field: text(),
      op: 'endsWith',
      value: TXT.a,
      insensitive: true,
    };
    const c: PredicateNode = { kind: 'isNull', field: int8n(), negated: true };
    await assertAgrees({
      kind: 'and',
      children: [
        { kind: 'or', children: [{ kind: 'not', child: { kind: 'and', children: [a, b] } }, c] },
        { kind: 'not', child: { kind: 'isNull', field: int8n(), negated: false } },
      ],
    });
  });

  it('empty AND is TRUE, empty OR is FALSE', async () => {
    await assertAgrees({ kind: 'and', children: [] });
    await assertAgrees({ kind: 'or', children: [] });
  });

  it('deeply nested NOT chain (NOT NOT NOT unknown) over a NULL column stays unknown', async () => {
    const base: PredicateNode = {
      kind: 'compare',
      field: int8n(),
      op: 'equals',
      value: I8.one,
      insensitive: false,
    };
    await assertAgrees({
      kind: 'not',
      child: { kind: 'not', child: { kind: 'not', child: base } },
    });
  });
});

it('report: number of (predicate, row) pairs compared', () => {
  // Populated by every `assertAgrees` call above; printed here since vitest runs `describe`
  // blocks before this top-level `it`, so the total is final by the time this executes.
  // eslint-disable-next-line no-console
  console.log(`differential suite: ${comparisons} (predicate, row) pairs compared`);
  expect(comparisons).toBeGreaterThan(0);
});
