# pgbase

Self-hosted Postgres BaaS for NestJS + Prisma. Clients query the database directly — live or
one-shot — through a typed SDK, inside a row-level-security envelope they cannot influence.

> **Status: pre-alpha, nothing implemented.** The design is settled and lives in
> [`docs/DESIGN.md`](./docs/DESIGN.md). Start at §14, then read §1–13 for the reasoning behind it.

## The pattern is CQS

Not CQRS with separate stores — one Postgres, two paths:

```
COMMANDS                                    QUERIES
────────                                    ───────
HTTP → NestJS controller → service          client SDK → socket → query compiler → SQL
imperative authz, business logic            declarative policies, no hand-written endpoints
mutations only                              reads only, live by default
```

The backend writes **no read endpoints**.

## Capability tiers

Cost regimes differ by orders of magnitude between a one-shot read and a live subscription, so
they don't get the same capability budget.

| Tier | Transport | Capability | Declaration |
|---|---|---|---|
| 1 | one-shot | Prisma's own args, narrowed to view fields — relation filters, includes, related counts | none |
| 2 | live, incremental | predicates over the entity's own columns | none |
| 3 | live, re-run-on-trigger | joins/aggregates kept live | explicit, per model |

## Subpath exports

| Import | Contents |
|---|---|
| `@workspace/pgbase` | core — the query AST, the shared evaluator, wire types |
| `@workspace/pgbase/nest` | `PgbaseModule`, `definePolicy`, the WAL leader, the socket gateway |
| `@workspace/pgbase/client` | framework-agnostic client |
| `@workspace/pgbase/react` | RTK Query bindings and hooks |

The core is dependency-light on purpose: the same `evaluate` runs on the server (against WAL
tuples) and in the browser (to fan one socket-level subscription out to many component queries).

## Scripts

- `pnpm build` — dual CJS/ESM build via tsup
- `pnpm dev` — watch mode
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm test` — vitest

## License

MIT
