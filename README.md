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

### 1. Configure Postgres

Logical replication is off by default, and `wal_level` **requires a server restart** — set it
before anything else.

| setting                  | value     | why                                                                     |
| ------------------------ | --------- | ----------------------------------------------------------------------- |
| `wal_level`              | `logical` | required for logical decoding at all; restart-only                      |
| `max_replication_slots`  | `≥ 2`     | one for the leader, headroom for a rolling deploy                       |
| `max_wal_senders`        | `≥ 2`     | one per active slot consumer                                            |
| `wal_sender_timeout`     | `10s`     | caps failover latency after a hard crash (default `60s`)                |
| `max_slot_wal_keep_size` | `2GB`     | keeps a stalled consumer from filling the disk (default: **unlimited**) |

```yaml
command:
  - postgres
  - -c
  - wal_level=logical
  - -c
  - max_replication_slots=8
  - -c
  - max_wal_senders=8
  - -c
  - wal_sender_timeout=10s
  - -c
  - max_slot_wal_keep_size=2GB
```

Everything except `wal_level` can be changed at runtime with `ALTER SYSTEM SET … ;
SELECT pg_reload_conf();`.

<details>
<summary>Why <code>max_slot_wal_keep_size</code> is the one you must not skip</summary>

A replication slot pins every WAL segment after its `confirmed_flush_lsn`, so Postgres keeps them
_on the consumer's behalf_ until it acknowledges. A leader that stops acknowledging — crashed,
OOM-killed, or orphaned by a deploy that renamed the slot — makes WAL grow without bound. The disk
fills, and Postgres stops accepting writes: the whole database goes down because of a component
that, by definition, nobody was being served by.

With a cap, Postgres invalidates the slot instead (`pg_replication_slots.wal_status = 'lost'`) and
reclaims the space. pgbase detects that, recreates the slot, and emits a resync so subscribers
refetch. You lose the subscription, never the database.

Size it above `peak write rate × longest expected leader outage` so routine deploys don't trip it —
tripping it on every deploy means every client refetches at once, which is its own outage.

Watch the lag with:

```sql
SELECT slot_name, active, wal_status,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained
FROM pg_replication_slots;
```

</details>

<details>
<summary>Failover, rolling deploys, and <code>wal_sender_timeout</code></summary>

A slot admits exactly one consumer, and Postgres enforces it — so the slot _is_ the leader lock.
Instances that lose the race retry until it frees up; no lease table or consensus protocol is
involved, and there is nothing that can disagree about who holds it.

How fast a standby takes over depends entirely on how the old leader died:

| shutdown                    | takeover                   | bounded by                              |
| --------------------------- | -------------------------- | --------------------------------------- |
| `SIGTERM` (rolling deploy)  | milliseconds               | pgbase releasing the slot on shutdown   |
| `SIGKILL` / OOM / node loss | up to `wal_sender_timeout` | Postgres noticing the walsender is gone |

TCP keepalives won't rescue the second case — `tcp_keepalives_idle` defaults to two hours. Lowering
`wal_sender_timeout` to `10s` caps the blackout; the trade-off is that a genuinely slow sender gets
terminated sooner, which is the correct outcome anyway.

pgbase releases the slot for you on shutdown, provided `app.enableShutdownHooks()` is called (step 4) and your process manager sends `SIGTERM` rather than `SIGKILL`. That is the difference between a
deploy nobody notices and a ten-second gap.

</details>

### 2. Add the generator to your Prisma schema

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

### 3. Declare a policy per model

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

### 4. Register the module

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

Then enable Nest's shutdown hooks in `main.ts`:

```ts
const app = await NestFactory.create(AppModule);
app.enableShutdownHooks(); // required — see below
```

pgbase stops the WAL leader in `onApplicationShutdown`, which releases the replication slot so a
standby instance takes over immediately. Nest only fires that hook on `SIGTERM`/`SIGINT` if
shutdown hooks are enabled, and it is off by default. Without this line the leader dies still
holding the slot, and every rolling deploy costs a live-update gap of up to `wal_sender_timeout`.
This is the one thing pgbase cannot do for you: `enableShutdownHooks()` lives on the application
instance, which a module has no reference to.

The `pool` is used once, at boot, to resolve the generated artifact against `pg_catalog` for
physical type OIDs and the join tables Prisma hides — never for queries. That resolution is also
the boot check, and it is deliberately fatal: it fails on a model with no primary key, on a schema
that has drifted from the database, and on `REPLICA IDENTITY FULL` combined with a publication
column list — a combination Postgres accepts and which then blocks every `UPDATE` and `DELETE` on
the table at DML time. Policies are validated in the same step, so a misconfigured policy can
never boot.

### 5. Read

Two entry points, one read path: in-process through an injected token, or over HTTP at
`POST /{routePrefix}/read` (default `POST /pgbase/read`). Same policy filter, same limits, same
result — they differ only in who is asking and how the row gets there.

**Server-side.** Declare the token once, then inject it like any other provider:

```ts
// pgbase/scoped-db.ts
export class ScopedDb extends ScopedPrismaToken<PrismaClient, typeof pgbasePolicies>() {}
```

```ts
@Injectable()
export class JobSummaryService {
  constructor(private readonly db: ScopedDb) {}

  async highPriorityJobCount(): Promise<{ count: number }> {
    // Compiles to `WHERE "orgId" IN (…caller's orgs) AND "priority" >= 1` — the policy half is
    // added for you and cannot be overridden from here.
    const jobs = await this.db.job.findMany({ where: { priority: { gte: 1 } } });
    return { count: jobs.length };
  }
}
```

The claims come from the ambient request context, so a scoped read needs a request in flight — the
context middleware resolves the principal via `getPrincipal` and caches its claims per request.

**There is no escape hatch, by design.** `ScopedDb` does scoped reads and nothing else. Server-side
work with no caller to scope to — crons, queue workers, migrations, backfills — injects your
`PrismaClient` the ordinary way; it is not a lesser path, it is the correct one for code that has
no principal. Wrapping it in a pgbase-branded bypass would buy a `reason` string and cost every
such job a callback that can't cross a service boundary.

Calling a scoped delegate outside a request throws rather than reading something arbitrary, and
says so in those terms:

```
No pgbase request context. A scoped read derives its row filter from the caller's claims, so it
can only run while a request is in flight — PgbaseContextMiddleware establishes that context.
This call reached a scoped delegate from somewhere else: a cron, a queue worker, a startup hook,
or work that outlived the request that began it. Server-side work with no caller to scope to
should use your PrismaClient directly.
```

**Client-side.** The typed SDK doesn't exist yet, so today a client calls the endpoint directly.
The body is `{ model, args }`, where `model` is the **Prisma model name** and `args` accepts
`where`, `select`, `include`, `orderBy`, `take`, `skip`, `cursor`, and `distinct` — any other key
is a 400 rather than a silently ignored field:

```ts
import SuperJSON from 'superjson';

const res = await fetch('/pgbase/read', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...authHeaders },
  body: JSON.stringify({
    model: 'Job',
    args: {
      where: { priority: { gte: 1 } },
      orderBy: { createdAt: 'desc' },
      include: { tags: true },
      take: 20,
    },
  }),
});

if (!res.ok) {
  // { statusCode, error, message } — 400 ReadValidationError, 403 ScopeViolationError.
  throw new Error((await res.json()).message);
}

// The response is a superjson envelope, so bigint / Date / Decimal survive the trip.
const jobs = SuperJSON.deserialize<Job[]>(await res.json());
```

Authentication is yours: pgbase calls the `getPrincipal(req)` you supplied and never looks at the
request itself, so whatever your app already uses — cookie, bearer token, session — keeps working
unchanged. The request body is parsed as plain JSON rather than superjson, so `args` can only carry
JSON-representable values; only the response is superjson-encoded.

The token is a class rather than a symbol so it carries your client and policy registry as
generics — `db.job` is typed from your schema, models without a policy don't exist on it, and no
`@Inject` is needed. A scoped delegate currently exposes **`findMany` only** — `findFirst`,
`count`, and aggregates aren't on it yet, so a read that needs one has to wait for tier 1 to grow
them or be written against Prisma with the policy filter applied by hand.

## Postgres requirements

Step 1 gives you the server settings. This is the rest of the picture: what the read path needs
versus the live path, what pgbase creates for you versus what it refuses to, and how each knob is
spelled on the managed providers.

**PostgreSQL 15 or newer.** Boot-time schema resolution reads `pg_publication_rel.prattrs`, and
that column arrived with publication column lists in PG 15. The dev image is 16.

**Nothing else is a prerequisite.** No extensions — `citext` is detected and handled if a column
uses it, never required. No superuser on the read path. And in particular **no native Postgres
RLS**: a policy's `rls` predicate is compiled into the query and evaluated in-process, and
`CREATE POLICY` is deliberately not used (§14.10 — logical decoding bypasses RLS entirely, so
native policies would contribute nothing to the live path and would cost the routing keys the
compiled predicate provides). Generating `CREATE POLICY` from the same registry as
defense-in-depth is a roadmap item, not a requirement.

Every model needs a **primary key**. Boot fails on a table without one — a row with no identity
can't be tracked across a WAL stream.

### One-shot reads — implemented today

A `Pool` whose role can `SELECT` the application tables. Boot resolution reads `pg_class`,
`pg_attribute`, `pg_constraint`, and `pg_publication_rel`, all world-readable. Nothing to enable,
on any provider.

### Live subscriptions — what the WAL leader will need

Not wired into `PgbaseModule` yet; `@workspace/pgbase/wal` is the standalone piece. Configure the
database ahead of it and the switch-on is a no-op. Four things beyond the settings in step 1.

**The role needs the `REPLICATION` attribute** — both to open the replication connection and to
create the slot:

```sql
ALTER ROLE pgbase WITH REPLICATION;
```

**Create the publication yourself.** pgbase never creates it; it fails at boot with the exact DDL
if it's missing. The name defaults to `pgbase` and is the `publication` module option.

```sql
CREATE PUBLICATION pgbase FOR ALL TABLES;
-- or, explicitly:
CREATE PUBLICATION pgbase FOR TABLE "jobs", "users";
```

Two rules the leader enforces at boot rather than at the first write:

- **No column lists.** `FOR TABLE t (id, a)` is rejected. Excluded columns are silently absent from
  the wire, and a positional decode cannot tell "excluded" from "not this table" — it would
  misattribute values to the wrong column.
- **With an explicit table list, every listed table must be a model**, or the leader has nothing to
  interpret its rows with. `FOR ALL TABLES` is exempt: unmodeled tables like `_prisma_migrations`
  are decoded and dropped.

`FOR ALL TABLES` itself requires superuser on self-hosted Postgres, and managed providers vary in
how far their admin role stretches (AWS documents it for `rds_superuser`). If yours rejects it, an
explicit `FOR TABLE` list works identically.

The slot itself is not your job — pgbase calls `pg_create_logical_replication_slot(slot, 'pgoutput')`
on start if it is absent, and the one-consumer rule does the leader election (step 1).

**`REPLICA IDENTITY FULL` is per-table and opt-in.** It buys DELETE filtering and field-level
patches; it is paid at write time by every writer whether anything is subscribed or not. Prisma
migrations don't emit it — add it to a migration by hand:

```sql
ALTER TABLE "jobs" REPLICA IDENTITY FULL;
```

Leaving it at the default is a supported fallback, not a misconfiguration: those tables degrade to
full-row updates and unfilterable deletes. Never combine `FULL` with a column-list publication —
Postgres accepts the DDL and then blocks every `UPDATE` and `DELETE` on the table, which is why
boot rejects the combination up front.

**The replication connection cannot go through a transaction pooler.** PgBouncer, RDS Proxy, and
Supabase's `:6543` pooler don't speak the replication protocol; point the replication config at the
primary directly. Pass-through TCP proxies like the Cloud SQL Auth Proxy are fine.

### Per-provider setup

The step 1 settings, spelled for each provider. Two of the five are not yours to set on managed
Postgres, which changes what the failure modes look like — read the last two rows before assuming
the local configuration transfers.

| step 1 setting           | local         | AWS RDS / Aurora                      | GCP Cloud SQL                           | Azure flexible server             |
| ------------------------ | ------------- | ------------------------------------- | --------------------------------------- | --------------------------------- |
| `wal_level = logical`    | `-c`, restart | `rds.logical_replication = 1`, reboot | `cloudsql.logical_decoding = on`        | `wal_level`, restart              |
| `max_replication_slots`  | any           | set by `rds.logical_replication`      | flag, restart, default 10               | static, `2`–`262143`, default 10  |
| `max_wal_senders`        | any           | set by `rds.logical_replication`      | flag, restart, default 10               | static, `5`–`100`, default 10     |
| `wal_sender_timeout`     | any           | parameter, dynamic                    | **not settable** — not a Cloud SQL flag | dynamic, `0`–`2147483647` ms      |
| `max_slot_wal_keep_size` | any           | parameter, dynamic, default `-1`      | **floor is 100 GB** (`102400` MB)       | **not settable** — read-only `-1` |

The two bold cells are the ones to plan around:

- **Cloud SQL can't lower `wal_sender_timeout`.** A hard-crashed leader keeps the slot marked
  active for the full 60s default, so that is your worst-case live-update gap on GCP — you can
  shorten it on RDS and Azure, not here.
- **Neither Cloud SQL nor Azure gives you a 2GB disk guard.** Cloud SQL's minimum
  `max_slot_wal_keep_size` is 100 GB, and Azure pins it read-only at `-1` (unlimited) and instead
  drops unused slots on its own once storage crosses its threshold. On both, the guard that keeps a
  stalled consumer from filling the disk is a storage alert plus a slot-lag alert, not the
  parameter.

**Local.** `docker-compose.yml` already does it. For a plain install they go in `postgresql.conf`
or on the command line as `-c` flags; `wal_level` needs a restart, the rest a reload.

**AWS RDS / Aurora.** Set `rds.logical_replication = 1` in a custom parameter group (a cluster
parameter group on Aurora) and **reboot** — it's a static parameter, and applying it also sets
`wal_level`, `max_wal_senders`, `max_replication_slots`, and `max_connections`. Turning it on needs
`rds_superuser`; the role pgbase connects as needs `rds_replication` to create and stream slots:

```sql
GRANT rds_replication TO pgbase;
```

RDS Proxy does not carry replication connections — give the leader a direct endpoint.

**GCP Cloud SQL.** `cloudsql.logical_decoding = on` is how Cloud SQL exposes `wal_level = logical`;
it needs a **restart**. The replication user needs the attribute at creation or after:

```sql
CREATE USER pgbase WITH REPLICATION IN ROLE cloudsqlsuperuser LOGIN PASSWORD '…';
-- or: ALTER USER pgbase WITH REPLICATION;
```

**Azure Database for PostgreSQL flexible server.** Set the `wal_level` server parameter to
`logical`, **restart the server**, then `ALTER ROLE pgbase WITH REPLICATION`. Budget
`max_replication_slots` deliberately: HA alone needs 4, and each read replica takes one more, on
top of the leader's. Two Azure-specific hazards:

- **HA failover drops logical slots** on PG 16 and earlier — use the `pg_failover_slots` extension
  with `hot_standby_feedback = on`. PG 17+ syncs slots natively via `sync_replication_slots`.
  Without one of those, a failover loses the slot; the leader recreates it at the current LSN and
  everything written in the gap is simply never decoded, so treat a failover as a resync.
- **Azure drops unused slots automatically** once storage crosses its threshold, since you can't
  set `max_slot_wal_keep_size` yourself. Same outcome as tripping the cap — an invalidated slot and
  a resync — but on a threshold you don't choose and can't see coming.

### Verifying

```sql
SHOW wal_level;                                            -- logical
SELECT rolreplication FROM pg_roles WHERE rolname = current_user;   -- t
SELECT pubname, puballtables FROM pg_publication;          -- the publication exists
SELECT slot_name, plugin, active FROM pg_replication_slots;
SELECT relname, relreplident FROM pg_class WHERE relname = 'jobs';  -- 'f' = FULL, 'd' = default
```

## Subpath exports

| Import                      | Contents                                                            |
| --------------------------- | ------------------------------------------------------------------- |
| `@workspace/pgbase/nest`    | `PgbaseModule`, `PgbaseReadService`, `ScopedPrismaToken`            |
| `@workspace/pgbase/policy`  | `definePolicy`, `NO_CLIENT_ACCESS`, `PolicyRegistry`, validation    |
| `@workspace/pgbase/context` | `ClaimsBuilder`, the claims cache, scoped-write assertions          |
| `@workspace/pgbase/query`   | the query AST, `normalize`, `evaluate`, `compileSql`                |
| `@workspace/pgbase/read`    | read scoping, result plans, the wire codec                          |
| `@workspace/pgbase/schema`  | `PgCatalogSchemaProvider` and resolved-schema types                 |
| `@workspace/pgbase/wal`     | `createWalLeader`, the pgoutput decoder, change/resync events       |
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
