# pgbase

Self-hosted Postgres BaaS for NestJS + Prisma. Clients query the database directly — live or
one-shot — through a typed SDK, inside a row-level-security envelope they cannot influence.

> **Status: pre-alpha.** The schema registry, policy validation, claims, and **one-shot reads**
> work — over HTTP and in-process. Live subscriptions, the client SDK, and the React bindings do
> not exist yet; `@workspace/pgbase/client` and `/react` are empty stubs.

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

| Tier | Transport               | Capability                                                                              | Declaration         |
| ---- | ----------------------- | --------------------------------------------------------------------------------------- | ------------------- |
| 1    | one-shot                | Prisma's own args, narrowed to view fields — relation filters, includes, related counts | none                |
| 2    | live, incremental       | predicates over the entity's own columns                                                | none                |
| 3    | live, re-run-on-trigger | joins/aggregates kept live                                                              | explicit, per model |

Only tier 1 is implemented today.

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

Logical decoding reports _physical_ names — `jobs`, `created_at` — never the Prisma names `Job`
and `createdAt`. Mapping a WAL event back to a model, a policy, and a transform therefore needs
that mapping as runtime **data**, and TypeScript types are erased at runtime.

It cannot be recovered from what Prisma already generates: the generated client's
`runtimeDataModel` is empty, its per-model files are types only, and the sole remaining copy of the
schema is unparsed text consumed by a WASM query compiler. `@@map` is arbitrary, so convention
cannot infer it either, and `pg_catalog` knows the physical side but nothing about Prisma names.

</details>

### 2. Declare a policy per model

A policy's `rls` predicate is the row filter for every read of that model, derived from the
caller's claims. The registry is exhaustive — a model you forget is a `tsc` error, not a
boot-time surprise — and models with no client access are opted out explicitly:

```ts
import { NO_CLIENT_ACCESS, definePolicy, type PolicyRegistry } from '@workspace/pgbase/policy';

const jobPolicy = definePolicy<JobModel, Claims>('Job')({
  rls: (claims) => ({ orgId: { in: claims.orgIds } }),
});

export const pgbasePolicies = {
  Job: jobPolicy,
  // Holds `webhookSecret` — never reachable from the client, not even nested under `include`.
  JobSettings: NO_CLIENT_ACCESS,
  // …every other model
} satisfies PolicyRegistry<Prisma.ModelName>;
```

Claims come from a `ClaimsBuilder` you write — an ordinary Nest provider, so it can inject a
repository or a feature-flag service. pgbase owns _when_ it is rebuilt and cached; you own how it
is computed.

### 3. Register the module

`forRootAsync` takes the Prisma client and the schema pool from the container, so you build them
the ordinary way rather than at module scope:

```ts
PgbaseModule.forRootAsync({
  imports: [PrismaModule, SchemaPoolModule, ClaimsModule],
  inject: [PrismaService, SCHEMA_POOL, OrgMembershipClaimsBuilder],
  useFactory: (prisma: PrismaService, pool: Pool, claimsBuilder: OrgMembershipClaimsBuilder) => ({
    pool,
    prisma,
    schema: pgbaseSchema, // the generated artifact from step 1
    policies: pgbasePolicies,
    claimsBuilder,
    getPrincipal, // pulls the authenticated principal off the request
  }),
  scopedPrisma: ScopedDb, // see step 4
});
```

`forRoot` is the same thing with a constant factory, for apps with nothing to inject.
`scopedPrisma` and `routePrefix` sit outside the factory because they are read while the module
definition is built — the DI token and the controller's route exist before any provider runs.

The `pool` is used once, at boot, to resolve the generated artifact against `pg_catalog` for
physical type OIDs and the join tables Prisma hides — never for queries. That resolution is also
the boot check, and it is deliberately fatal: it fails on a model with no primary key, on a schema
that has drifted from the database, and on `REPLICA IDENTITY FULL` combined with a publication
column list — a combination Postgres accepts and which then blocks every `UPDATE` and `DELETE` on
the table at DML time. Policies are validated in the same step, so a misconfigured policy can
never boot.

### 4. Read

Two entry points, one read path. Over HTTP, the module mounts `POST /{routePrefix}/read`
(default `POST /pgbase/read`), taking `{ model, args }` — this is what the client SDK will call.

In-process, inject the token class you declared:

```ts
// pgbase/scoped-db.ts
export class ScopedDb extends ScopedPrismaToken<PrismaClient, typeof pgbasePolicies>() {}

// anywhere
constructor(private readonly db: ScopedDb) {}
await this.db.job.findMany({ where: { priority: { gte: 1 } } });
```

The token is a class rather than a symbol so it carries your client and policy registry as
generics — `db.job` is typed from your schema, models without a policy don't exist on it, and no
`@Inject` is needed. Both paths apply the same policy filter and the same limits;
`db.runUnscoped(reason, fn)` is the deliberate escape hatch.

## Subpath exports

| Import                      | Contents                                                            |
| --------------------------- | ------------------------------------------------------------------- |
| `@workspace/pgbase/nest`    | `PgbaseModule`, `PgbaseReadService`, `ScopedPrismaToken`            |
| `@workspace/pgbase/policy`  | `definePolicy`, `NO_CLIENT_ACCESS`, `PolicyRegistry`, validation    |
| `@workspace/pgbase/context` | `ClaimsBuilder`, the claims cache, scoped-write assertions          |
| `@workspace/pgbase/query`   | the query AST, `normalize`, `evaluate`, `compileSql`                |
| `@workspace/pgbase/read`    | read scoping, result plans, the wire codec                          |
| `@workspace/pgbase/schema`  | `PgCatalogSchemaProvider` and resolved-schema types                 |
| `@workspace/pgbase/client`  | _not implemented_ — framework-agnostic client                       |
| `@workspace/pgbase/react`   | _not implemented_ — RTK Query bindings and hooks                    |
| `@workspace/pgbase`         | _empty_ — the root entry exports nothing yet; import from a subpath |

`query` is dependency-light on purpose: the same `evaluate` is meant to run on the server (against
WAL tuples) and in the browser (to fan one socket-level subscription out to many component
queries). Only the server half exists today.

## Scripts

- `pnpm build` — dual CJS/ESM build via tsup, then asserts decorator metadata survived
- `pnpm dev` — watch mode
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm test` — vitest (needs the test database: `pnpm example:up`)
- `pnpm example:up` / `example:down` — docker compose; brings up both the example database
  (`:55432`) and the test database (`:55433`)
- `pnpm example:api` — run the example NestJS API

The build depends on `@swc/core`: tsup only emits `design:paramtypes` when it can resolve it, and
degrades to a warning otherwise, so `postbuild` fails the build rather than shipping a package
whose providers can't be resolved by Nest.

## License

MIT
