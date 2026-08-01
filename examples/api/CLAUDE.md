# CLAUDE.md — `examples/api/`

The NestJS half of the Opsboard example. It is a reference *installation* of pgbase and, at the
same time, **the fixture the package's own test suite runs against** — `src/nest/__tests__/`
imports `src/generated/{prisma,pgbase}` from here, and `test/global-setup.ts` migrates this schema
into `:55433`. Breaking this workspace breaks `pnpm test` at the repo root.

## Layout: installation vs. application

`src/pgbase/` is the entire cost of adopting pgbase — copy the folder, adapt `policies.ts`, done.
Every other folder is an ordinary Nest feature module that happens to inject `ScopedDb`.

- `pgbase.module.ts` — pool, claims, policies, scoped client, WAL config in one `forRootAsync`.
- `policies.ts` — one RLS predicate per model. **This is the whole authorization surface**; no
  controller or service re-checks the caller. `pgbasePolicies` is exhaustive by `satisfies`, so a
  new model is a `tsc` error here before it is a runtime problem.
- `claims.ts` — note the "ortho" pattern: `User`'s RLS cannot express "shares an org with the
  caller" as a predicate over `User`'s own columns, so the claims builder precomputes
  `visibleUserIds` and the policy stays a plain `in`. Reach for this whenever a policy wants a join.
- `caller.ts` — reads the ambient request context for `userId`/`orgId` in write paths.
- `dev-principal.ts` — **the one file to replace before this is anything but a harness.** It reads
  a user id from a header. It also demonstrates the required dual read: HTTP requests carry
  `headers`, socket handshakes carry `auth`, because a browser cannot set headers on a WebSocket.
- `scoped-db.ts` — the `ScopedPrismaToken` subclass that makes `ScopedDb` injectable and typed.

Feature modules follow one shape: validated DTO → controller → service on `ScopedDb`. Services do
business logic and nothing about identity. Controllers publish to no socket; the WAL does that.
Response DTOs are deliberately absent — `policies.ts` already strips omitted columns — but a real
public API should still add them.

## The Prisma schema is hostile on purpose

`prisma/models/*.prisma` is not a realistic app schema. Every model exists to break something:
composite keys, `int8` past `Number.MAX_SAFE_INTEGER`, `Decimal(18,4)`, a self-relation, a text
array, jsonb, and `AuditLog` with **no tenant column** (proving the router's wildcard bucket).
Read each file's header comment before changing it, and expect a change here to surface as a
failure in the root package's differential or decode-agreement suites.

Two deliberate configurations that look like mistakes:

- **`audit_log` is left at default replica identity** while every other table is
  `REPLICA IDENTITY FULL`. It is the Tier B degraded-path fixture. Do not "fix" it.
- **jsonb defaults are plain literals** (`@default("{}")`), never function defaults — a function
  default re-emits on every `migrate`.

## Hand-written migrations

Three things Prisma will never generate and never notice are missing:

| migration | why it cannot be generated |
| --- | --- |
| `..._replica_identity_and_partial_indexes` | `REPLICA IDENTITY` has no Prisma syntax; neither does a partial (`WHERE`) unique index |
| `..._pgbase_publication` | Prisma has no concept of a publication |

**Known consequence:** `prisma migrate dev` does not know about the partial unique index
`jobs_one_running_per_org` and will report the database as drifted and offer to reset. That is the
real cost of raw DDL under Prisma Migrate, not a bug in the migration. Do not resolve it by
deleting the index.

The publication is `FOR ALL TABLES` with **no column list** — a column list combined with
`REPLICA IDENTITY FULL` blocks every `UPDATE`/`DELETE` at DML time, which pgbase rejects at boot.

## Prisma 7 specifics

- The connection URL lives in `prisma.config.ts` (which calls `process.loadEnvFile()`), not in an
  inline `url = env(...)` — Prisma 7 rejects that with P1012.
- `generator client` sets `moduleFormat = "cjs"` explicitly; left unset it is inferred from the
  nearest tsconfig, and pgbase must work under either.
- Generator and `datasource` blocks must stay in `prisma/schema.prisma` (the root of the configured
  schema directory) even though models live in `prisma/models/`.
- `src/generated/` is gitignored build output, but the root test suite imports it — run
  `pnpm --filter @pgbase-example/api db:generate` after any schema change.

## Running and testing

Needs `.env` (copy `.env.example`); `validateEnv` fails loudly with that instruction. The dev DB is
`:55432`, seeded with two orgs — Alice and Bob share one, Carol is the isolation case.

E2E specs (`test/*.e2e-spec.ts`) build the real `AppModule` and call the same `configureApp` that
`main.ts` uses, so validation, CORS and shutdown wiring are exercised rather than a drifting second
copy. They use `app.listen(0)` — a real listening port, because socket.io attaches to the HTTP
server and `app.init()` alone is not enough. `PGBASE_SLOT=pgbase_e2e` is set in `vitest.config.ts`,
not in a hook: `ConfigModule.forRoot()` validates the environment while `app.module.ts` is being
imported, which happens before any hook runs. Without it, a running dev server owns the slot and
the suite silently falls back to standby — indistinguishable from "no deltas ever arrive".

Vitest here uses the SWC plugin, not esbuild: esbuild does not implement `emitDecoratorMetadata`,
so without it every injected dependency arrives `undefined` and the module fails to boot.
