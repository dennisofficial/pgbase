# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@dltech/pgbase` — a self-hosted Postgres BaaS library for NestJS + Prisma. Clients read the
database directly (one-shot or live over a socket) through a typed SDK, inside an RLS envelope they
cannot influence. The pattern is **CQS over one Postgres**: writes go through hand-written NestJS
controllers/services; reads go through declarative policies and a query compiler, so the backend
writes _no read endpoints_.

`README.md` is the user-facing manual and is the authority on the public API and Postgres setup.
`docs/DESIGN.md` (1471 lines) is deleted from the working tree but still in `HEAD` —
`git show HEAD:docs/DESIGN.md` recovers it. Comments across the repo cite it by section (`§7.5`),
and §14 records amendments that override §1–13, so read §14 first.

## Commands

Postgres must be up before anything test-related:

```bash
pnpm example:up      # both compose DBs: dev :55432, test :55433 (tmpfs)
pnpm build           # tsup, dual CJS/ESM + .d.ts/.d.mts
pnpm typecheck       # tsc --noEmit
pnpm test            # vitest, src/**/*.test.ts
pnpm vitest run src/query/__tests__/normalize.test.ts   # one file
pnpm vitest run -t 'partial name'                       # one test
```

The example app (also the test fixture):

```bash
pnpm example:seed    # prisma migrate dev + seed, against :55432
pnpm example:api     # NestJS on :3001
pnpm example:web     # Next.js on :3000
pnpm --filter @pgbase-example/api test:e2e   # e2e specs; needs examples/api/.env
```

Notable coupling: **`pnpm test` depends on the example workspace.** `test/global-setup.ts` runs
`prisma migrate deploy` + `prisma generate` inside `examples/api` against `:55433`, and
`src/nest/__tests__/real-prisma.ts` imports `examples/api/src/generated/{prisma,pgbase}`. A broken
example schema breaks the package's own suite. `examples/api/prisma/models/*.prisma` is
deliberately hostile (composite keys, `int8`, `Decimal(18,4)`, self-relation, a table with no
tenant column) because it doubles as the differential-property fixture — read the header comments
before changing it.

`fileParallelism` is off in both vitest configs: replication slots are a single-consumer,
exhaustible resource, so suites that spin up WAL leaders cannot overlap. The example e2e config
pins `PGBASE_SLOT=pgbase_e2e` so it never loses the slot race to a running dev server (which is
indistinguishable from "no deltas ever arrive").

There is no lint step. Prettier (`prettier-plugin-organize-imports`, single quotes, 100 cols) is
the only formatter.

## Architecture

The read path is one pipeline, split across `src/` modules that each own one stage. Following a
request end to end means reading them in this order:

- **`schema/`** — the generated `StaticSchema` is resolved against `pg_catalog` at boot into a
  `ResolvedSchema`: physical table/column names, type OIDs, primary keys, the join tables Prisma
  hides. This resolution is deliberately fatal (no PK, schema drift, `REPLICA IDENTITY FULL` +
  column-list publication) — a misconfiguration must fail at boot, never at DML time.
- **`policy/`** — one `definePolicy` per model; the registry is exhaustive (`satisfies
PolicyRegistry<Prisma.ModelName>`), so a forgotten model is a `tsc` error and models with no
  client access are `NO_CLIENT_ACCESS`. `omit`ted columns are both stripped from results
  (`project.ts`) and removed from the filterable set (`filterable.ts`).
- **`query/`** — `LiveWhere` → `normalize()` → `PredicateNode`, with **two backends over one AST**:
  `compileSql` for the server and `evaluate` for in-memory judgement of WAL tuples. That a read and
  a live delta agree is exactly this shared AST; `__tests__/differential.test.ts` asserts it
  against real Postgres. `query/` is kept dependency-light because `evaluate` is meant to run in
  the browser too.
- **`read/`** — `scopeRead` validates client `args`, ANDs the policy predicate into every `where`
  at every nesting level, and emits a `ResultPlan`; `applyPlan` projects rows; `wire.ts` is the
  superjson codec that keeps `bigint`/`Date`/`Decimal`/`Uint8Array` intact over HTTP and socket.
- **`context/`** — AsyncLocalStorage request context. `getPrincipal(req)` → `ClaimsBuilder` →
  cached claims. A scoped delegate touched outside a request throws rather than reading something
  arbitrary. `scoped-write.ts` holds the create/update pre- and post-image assertions.
- **`wal/`** — `pgoutput` decoder plus the leader. **The replication slot is the leader lock**:
  Postgres admits one consumer per slot, so instances that lose the race retry; there is no lease
  table. `decode.ts`/`encode.ts` translate raw pgoutput text into Prisma-shaped values.
- **`live/`** — `registry` (subscriptions by model), `router` (evaluate the predicate against
  old/new row → `add`/`update`/`remove`/`resync`), `sink` (bounded queue; overflow degrades to a
  resync rather than a silent gap), `protocol`, `subscription`.
- **`transport/`** — cross-instance fan-out (Postgres `NOTIFY` or Redis) so non-leader instances
  serve subscriptions from the leader's decoded changes.
- **`nest/`** — the wiring: `PgbaseModule.forRoot(Async)`, the read controller, the socket.io
  gateway and `live-runtime`, and `scoped-prisma` (a typed Prisma facade whose delegates are
  restricted to scoped operations, with no bypass method by design).
- **`client/`, `react/`** — the SDK, `useLiveQuery`, and the RTK Query binding.
- **`generator/`** — the `pgbase` bin. With no arguments it is the Prisma generator (DMMF → a
  static TS schema module in `index.ts`, plus client row types in `models.ts`); with a command it
  is a setup helper (`pgbase publication`). Bare invocation _must_ stay generator mode: Prisma
  spawns it with no args and speaks JSON-RPC over stdio, so anything written to stdout there
  corrupts that channel. The schema module exists because logical decoding reports physical names
  only, so the Prisma↔physical mapping must survive as runtime _data_; nothing Prisma generates
  carries it. `SCHEMA_FORMAT_VERSION` lives in `src/version.ts` and must be bumped when the emitted
  shape changes.

### Invariants that are easy to break

- **One `publication` option, at the top level.** Both the schema resolver and the WAL leader read
  it. A resolver pointed at a publication that does not exist gets no `pg_publication_rel` rows,
  which is indistinguishable from "published, no column list" — so the FULL + column-list guard
  silently stops being a guard. Never reintroduce a second per-consumer knob; `resolver.ts` warns
  when the publication is missing _and_ a table is FULL, which is the only case where it matters.
- **`getPrincipal` receives a normalized `PgbaseRequest`, never a raw request.** HTTP carries
  credentials in headers, socket.io in the handshake `auth` payload (a browser WebSocket cannot set
  headers). `credential()` checks both. `auth` is populated for sockets only, so an HTTP body cannot
  smuggle one past the header path.
- **`src/index.ts` is intentionally empty.** Everything ships as a subpath. Adding a module means
  adding it to _both_ `tsup.config.ts`'s `entry` array and `package.json`'s `exports` map, with
  matching `import`/`require` type paths — the publish workflow gates on `publint` and
  `arethetypeswrong` precisely because those failures are invisible to the test suite.
- **Relative imports carry `.js` extensions** (NodeNext resolution), including from `.ts` sources.
- **A live `where` must stay a strict subset of Prisma's filter shapes.**
  `examples/api/src/pgbase-prisma-conformance.ts` is a compile-time-only proof of `pgbase ⊆ Prisma`;
  `pnpm typecheck` on the example is the assertion. Never widen pgbase to accept something Prisma
  does not.
- **Live queries are limited to predicates over the model's own columns** — no relation filters,
  no `include`/`orderBy`/`take`/`skip`. A WAL event hands you one row, so anything requiring rows
  you were not handed cannot be decided. A snapshot that would hit `limits.maxRows` is refused
  rather than truncated, because a truncated snapshot plus a full delta stream never converges.
- **No native Postgres RLS.** `CREATE POLICY` is deliberately unused: logical decoding bypasses it,
  so it would contribute nothing to the live path while costing the routing keys that the compiled
  predicate provides.
- **`REPLICA IDENTITY FULL` changes behaviour, not just cost.** Without a pre-image the router
  stays silent when a row leaves a subscriber's scope (naming its key would disclose the row's
  existence); deletes are the exception and are always sent.
- **Error mapping:** pgbase's own filter maps `ReadValidationError` → 400, `ScopeViolationError`
  → 403, and `ScopedRowNotFoundError` → 404. The 404 is load-bearing: it is deliberately identical
  to "row does not exist", because a distinct status would confirm the row exists. Global filters
  are selected first-match in registration order, so an app cannot reliably shadow this one from
  another module — that is why the guidance is to catch it in a service instead.
- Bulk operations (`upsert`, `createMany`, `updateMany`, `deleteMany`, `*AndReturn`) are
  unscoped-by-refusal — they throw naming why. Do not add them without a story for proving a
  post-image stayed in scope.

## Comments and style

The codebase's comments are dense _rationale_, not description — they explain the failure mode a
line prevents, usually with a design-doc section reference. Match that: write a comment only for
what the code cannot express, and never restate what the code already says.

## Releasing

Work happens directly on `main`; pushing does not publish. A **version-bump commit** is the
release trigger: `pnpm changeset` → `pnpm release` → commit → push. `publish.yml` verifies
(typecheck + suite against real compose services), then publishes only if `package.json`'s version
has no matching git tag. `feat/*` PRs additionally require a changeset.
