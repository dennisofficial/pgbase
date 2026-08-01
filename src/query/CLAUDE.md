# CLAUDE.md — `src/query/`

One predicate AST, two backends. `compileSql` runs it as SQL against Postgres for reads;
`evaluate` runs it in memory against a decoded WAL tuple for live deltas. **These two must agree
on every input**, because a read and a subsequent delta that disagree produce a client whose list
silently diverges from the database.

`__tests__/differential.test.ts` is the enforcement: it builds predicates over
`differential-fixture.ts`, runs both backends against real Postgres rows on `:55433`, and asserts
identical row sets. Treat a failure there as a correctness bug, never as a flaky test.

This module is kept dependency-light on purpose — `evaluate` is meant to run in the browser, so a
single socket subscription can eventually fan out to many component-level queries. Do not import
`pg`, Nest, or anything server-only here.

## Adding or changing an operator

An operator is not "added" until every one of these is touched. Missing any one of the middle
three produces a silent read/live divergence rather than a compile error:

1. **`ast.ts`** — the `ComparisonOp`/`SetOp`/`ListOp` union *and* the `Live*Filter` wire
   interface that exposes it.
2. **`normalize.ts`** — `ALLOWED_OPERATORS` per `FieldCategory` (`list` | `string` | `bool` |
   `scalar` | `json`), plus the parsing that turns the wire filter into a `PredicateNode`. An
   operator absent from the category's set is rejected, which is the safe default.
3. **`compile-sql.ts`** — SQL emission.
4. **`evaluate.ts`** — the in-memory branch.
5. **`compare.ts`** — a per-OID comparator, if the operator compares values.
6. **`examples/api/src/pgbase-prisma-conformance.ts`** — the compile-time proof that pgbase's
   filter shape stays a subset of Prisma's. `pnpm --filter @pgbase-example/api typecheck` is the
   assertion; there is no runtime.

Then extend `differential-fixture.ts` so the new operator is actually covered by the differential
suite. An operator with no fixture row is untested by construction.

## Value representation

`normalize` coerces predicate values into the *internal comparable form* via `coerceValue`, which
is the same form `src/wal/decode.ts` produces. Both backends compare in that form; neither ever
compares raw wire text.

Two rules that cause real bugs when forgotten:

- **`Decimal` and `BigInt` arrive as strings** from both node-postgres and pgoutput. A bare `<` on
  them is wrong at the edges (`9007199254740993` is not a JS number, and `Decimal(18,4)` exceeds
  IEEE-754). That is why comparison dispatches per type OID in `compare.ts` instead of using JS
  operators directly.
- **`JSON_NULL` is a symbol, distinct from `null`.** A JSON `null` stored in a `jsonb` column and a
  SQL `NULL` are different values, and conflating them makes `equals: null` match the wrong rows.

`referencedColumns` (`columns.ts`) walks a predicate for the columns it reads. The live router
depends on it to decide whether a change with unknown (TOAST-unchanged) columns is decidable, so a
new node kind must be handled there too or it will under-report and route on incomplete data.
