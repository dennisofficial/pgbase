# pgbase

Self-hosted Postgres BaaS for NestJS + Prisma. Clients query the database directly — live or
one-shot — through a typed SDK, inside a row-level-security envelope they cannot influence.

> **Status: pre-alpha.** The schema registry works; the query path does not exist yet.

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

## Getting started

### 1. Add the generator to your Prisma schema

pgbase ships a Prisma generator. Add a second `generator` block beside your client:

```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

generator pgbase {
  provider = "pgbase"
  output   = "../src/generated/pgbase"
}
```

`prisma generate` now produces both. **Gitignore the output** alongside your Prisma client — it is
build output, not source:

```gitignore
**/generated/
```

<details>
<summary>Why a second generated artifact is necessary</summary>

Logical decoding reports *physical* names — `jobs`, `created_at` — never the Prisma names `Job`
and `createdAt`. Mapping a WAL event back to a model, a policy, and a transform therefore needs
that mapping as runtime **data**, and TypeScript types are erased at runtime.

It cannot be recovered from what Prisma already generates: the generated client's
`runtimeDataModel` is empty, its per-model files are types only, and the sole remaining copy of the
schema is unparsed text consumed by a WASM query compiler. `@@map` is arbitrary, so convention
cannot infer it either, and `pg_catalog` knows the physical side but nothing about Prisma names.

</details>

### 2. Resolve it at boot

The generated artifact carries names and shapes. Physical type OIDs and the join tables Prisma
hides come from `pg_catalog` on a pool you own:

```ts
import staticSchema from './generated/pgbase';
import { PgCatalogSchemaProvider } from '@workspace/pgbase/schema';

const schema = await new PgCatalogSchemaProvider(staticSchema, pool).resolve();
```

Resolution is also the boot check: it fails loudly on a model with no primary key, a schema that
has drifted from the database, and on `REPLICA IDENTITY FULL` combined with a publication column
list — a combination Postgres accepts and which then blocks every `UPDATE` and `DELETE` on the
table at DML time.

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
