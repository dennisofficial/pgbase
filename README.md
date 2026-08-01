# pgbase

Self-hosted Postgres BaaS for NestJS + Prisma. Clients query the database directly — live or
one-shot — through a typed SDK, inside a row-level-security envelope they cannot influence.

> **Status: pre-alpha.** One-shot reads, live subscriptions, the typed client SDK, and the React
> hook all work — the example app in [`examples/`](examples/README.md) runs on them end to end.
> Not built yet: live re-run for joins and aggregates, and the root `@dltech/pgbase` entry, which
> is empty — import from a subpath.

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

## Reads and live queries

A **read** asks Postgres a question and gets an answer. A **live query** never gets to ask: it sees
one changed row at a time, straight off the write-ahead log, and has to decide on its own whether
that row still belongs in your result.

That difference is the whole reason the two have different capability budgets. You can't join
against rows you were never handed, so a live query is limited to predicates over the model's own
columns, while a read can do anything Prisma can.

| Query         | What it can express                                                                        | Declaration         |
| ------------- | ------------------------------------------------------------------------------------------ | ------------------- |
| **read**      | Prisma's own args, narrowed to visible fields — relation filters, includes, related counts | none                |
| **live**      | predicates over the model's own columns                                                    | none                |
| _live re-run_ | joins and aggregates kept live, by re-running on an upstream change — **not built yet**    | explicit, per model |

The first two rows work today. Live re-run is the one that does not exist yet.

## Getting started

Install the package, plus the peers for the halves you actually use — every peer is optional and
declared as such, so nothing is pulled in for a side of the stack you aren't building:

```bash
pnpm add @dltech/pgbase
```

| you're building             | also install                                          |
| --------------------------- | ----------------------------------------------------- |
| the Nest server             | `@nestjs/common` `@nestjs/core` `@prisma/client` `pg` |
| live subscriptions (server) | `socket.io`                                           |
| a client (browser or node)  | `socket.io-client`                                    |
| the React hook              | `react` 19+                                           |
| the RTK Query binding       | `@reduxjs/toolkit` 2+                                 |

Node 20+, Prisma 7, NestJS 11, PostgreSQL 15+. `pg` is a direct dependency of pgbase, but you
construct the `Pool` yourself and hand it to the module, so depend on it explicitly rather than
reaching through pgbase's copy.

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
import { NO_CLIENT_ACCESS, definePolicy, type PolicyRegistry } from '@dltech/pgbase/policy';

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
    schema: pgbaseSchema, // the generated artifact from step 2
    policies: pgbasePolicies,
    claimsBuilder,
    getPrincipal, // pulls the authenticated principal off the request
    // Omit `live` entirely and you get reads only: no replication connection, no socket server.
    live: {
      replicationConfig: { connectionString: process.env.DATABASE_URL },
      slotName: 'pgbase_myapp',
      publication: 'pgbase',
      socketIoOptions: { cors: { origin: 'https://app.example.com' } },
    },
  }),
  scopedPrisma: ScopedDb, // see step 5
});
```

`forRoot` is the same thing with a constant factory, for apps with nothing to inject.
`scopedPrisma`, `routePrefix`, and `schemaProvider` sit outside the factory because they are read
while the module definition is built — the DI token and the controller's route exist before any
provider runs.

The rest of the options, all optional:

| option               | what it does                                                               |
| -------------------- | -------------------------------------------------------------------------- |
| `live`               | turns on the WAL leader and the socket.io gateway; absent means reads only |
| `publication`        | publication name used by boot-time schema resolution (default `pgbase`)    |
| `routePrefix`        | the read controller's route (default `pgbase`, so `POST /pgbase/read`)     |
| `limits`             | read result limits — max rows, max depth                                   |
| `argsLimits`         | bounds on the incoming `args` tree, checked before anything walks it       |
| `serializers`        | extra wire types beyond the built-ins                                      |
| `decimalConstructor` | makes `numeric` deltas arrive as `Decimal` rather than a string            |
| `claimsCacheOptions` | TTL and size of the per-principal claims cache                             |
| `schemaProvider`     | replaces `pg_catalog` resolution, mostly for tests                         |

The `live` block needs a database that has been prepared for it — a role with `REPLICATION`, and a
publication you create in a migration. Both are covered under
[Postgres requirements](#live-subscriptions--what-the-wal-leader-needs); the leader checks them at
boot and fails with the exact DDL to run.

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
result — they differ only in who is asking and how the row gets there. The in-process token also
carries the write side, since a command that touches the caller's own rows wants the same filter.

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

**There is no escape hatch, by design.** `ScopedDb` does scoped work and nothing else — there is no
bypass method on it and no way to drop the filter. Server-side work with no caller to scope to —
crons, queue workers, migrations, backfills — injects your `PrismaClient` the ordinary way; it is
not a lesser path, it is the correct one for code that has no principal. Wrapping it in a pgbase-branded bypass would buy a `reason` string and cost every
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

The token is a class rather than a symbol so it carries your client and policy registry as
generics — `db.job` is typed from your schema, models without a policy don't exist on it, and no
`@Inject` is needed. A scoped delegate covers reads and single-row writes:

| operations                                                                                               | scoping                                                                      |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `findMany` `findFirst` `findFirstOrThrow` `findUnique` `findUniqueOrThrow` `count` `aggregate` `groupBy` | the policy predicate is ANDed into `where`                                   |
| `create`                                                                                                 | the new row is proven in scope before it is written                          |
| `update` `delete`                                                                                        | the pre-image must be visible, and an update's post-image must stay in scope |

`update` and `delete` run inside a transaction that reads the row under the policy filter first, so
a row belonging to someone else raises `ScopedRowNotFoundError` — deliberately the same error as a
row that doesn't exist, because distinguishing the two is itself a disclosure. Nested relation
writes under `data` are rejected: a nested create writes a row the policy never saw.

pgbase's own exception filter maps `ReadValidationError` to 400 and `ScopeViolationError` to 403;
`ScopedRowNotFoundError` is left to you, since only your app knows whether it should surface as a
404 or as something quieter. One `@Catch(ScopedRowNotFoundError)` filter is enough, and keeps every
service free of `.catch(...)` plumbing.

The bulk operations — `upsert`, `createMany`, `updateMany`, `deleteMany`, and the `*AndReturn`
variants — are not scoped yet and throw an error naming why (a bulk update has no single post-image
to prove stayed in scope). Use your `PrismaClient` directly for those and enforce scope at the call
site.

**Client-side.** The typed SDK does the same read over HTTP:

```ts
// pgbase/client.ts — one client for the whole app
import { createClient } from '@dltech/pgbase/client';

interface Models {
  Job: Job;
  Task: Task;
}

export const pgbase = createClient<Models>({
  baseUrl: 'https://api.example.com',
  getAuth: () => ({ authorization: `Bearer ${accessToken()}` }),
});
```

```ts
const jobs = await pgbase.Job.findMany({
  where: { priority: { gte: 1 } },
  orderBy: { createdAt: 'desc' },
  include: { tags: true },
  take: 20,
});

const job = await pgbase.Job.findOne({ where: { id } }); // take: 1, or null
```

The keys of `Models` are **Prisma model names**, and their values are the row types you expect back
— hand-written today, since nothing generates client-side row types yet. `getAuth` is called per
request and per socket (re)connection rather than captured once, so a token that expires mid-session
refreshes itself; creating the client opens nothing.

Under the hood that is `POST /{routePrefix}/read` with a body of `{ model, args }`, where `args`
accepts `where`, `select`, `include`, `orderBy`, `take`, `skip`, `cursor`, and `distinct` — any
other key is a 400 rather than a silently ignored field. The endpoint answers a failure with
`{ statusCode, error, message }` — 400 `ReadValidationError`, 403 `ScopeViolationError` — and the
SDK raises it as a `PgbaseHttpError` carrying that status. The response is a superjson envelope, so
`bigint` / `Date` / `Decimal` survive the trip and the client decodes them for you. The request
body is plain JSON, so `args` can only carry JSON-representable values.

`prefix` (default `pgbase`) has to match the server's `routePrefix`, and `createSocket` lets you
hand in your own `io(...)` if your bundler needs socket.io-client constructed on your side. The
socket connects lazily, on the first live query.

Authentication is yours: pgbase calls the `getPrincipal(req)` you supplied and never looks at the
request itself, so whatever your app already uses — cookie, bearer token, session — keeps working
unchanged. One catch worth knowing before step 6: a browser cannot set headers on a WebSocket
handshake, so on a socket your `getAuth` values arrive in socket.io's `auth` payload instead.
`getPrincipal` receives the HTTP request in one case and the socket handshake in the other, and has
to read both:

```ts
function getPrincipal(req: unknown): Principal {
  const { headers, auth } = req as {
    headers?: Record<string, string>;
    auth?: Record<string, string>;
  };
  const token = headers?.authorization ?? auth?.authorization;
  // …verify and return your principal
}
```

### 6. Subscribe

A live query is a socket subscription: pgbase runs the read once for the initial snapshot, then
keeps it correct from the WAL. There is no polling and no invalidation to write.

```ts
const stop = pgbase.Job.subscribeMany({
  where: { status: 'RUNNING', labels: { has: 'urgent' } },
  onUpdate: (jobs) => render(jobs),
  onError: (err) => console.error(err),
});
```

`subscribeOne` is the same with the first row or `null`. `createSubscription()` gives you the
handle underneath — `query`, `getSnapshot`, `subscribe`, `close` — which is what the React binding
is built on.

**A live `where` is narrower than a read's.** It takes predicates over the model's own columns and
nothing else — no relation filters, no `include`, no `orderBy`, `take`, or `skip`. That is the
capability budget from the table above: a WAL event hands you one row, so anything requiring rows
you weren't handed can't be decided. Columns a policy omits aren't filterable either; the RLS
predicate itself is exempt, since the server authored it.

Because there is no `take`, a subscription whose snapshot hits `limits.maxRows` is refused rather
than truncated — a truncated snapshot and a full delta stream describe different sets, and the
subscriber would never converge. Narrow the filter, or use a one-shot read.

**React:**

```tsx
import { useLiveQuery } from '@dltech/pgbase/react';

const jobs = useLiveQuery(pgbase.Job, { where: { status: 'RUNNING' } });
```

Changing the `where` closes the old subscription and opens a new one, so the list redraws from a
fresh server snapshot rather than filtering a stale client-side copy.

**RTK Query**, for the same subscriptions inside an existing Redux cache:

```ts
export const liveApi = createApi({
  reducerPath: 'live',
  baseQuery: fakeBaseQuery<string>(),
  endpoints: (build) => ({
    activity: build.query<readonly AuditLog[], void>(liveQueryEndpoint(pgbase.AuditLog)),
  }),
});
```

`liveQueryEndpoint` opens the subscription in `queryFn` and feeds the cache entry from deltas for
as long as RTK holds it. Live rows keep their Prisma types — `bigint`, `Date`, `Decimal`,
`Uint8Array` — which RTK's default `serializableCheck` rejects, so widen it to exactly those rather
than switching it off:

```ts
getDefault({ serializableCheck: { isSerializable: isLiveSerializable } }).concat(
  liveApi.middleware,
);
```

**Connection state.** `pgbase.$status()` and `$onStatusChange` report
`idle | connecting | connected | disconnected | error`. On reconnect every subscription rebuilds
from a fresh server snapshot — there is no resumption by design, so a client never replays a gap it
cannot prove it saw all of. `$setAuth` swaps the identity and reconnects, which resyncs every open
subscription under the new claims instead of leaving rows the previous identity could see.

## Postgres requirements

Step 1 gives you the server settings. This is the rest of the picture: what the read path needs
versus the live path, what pgbase creates for you versus what it refuses to, and how each knob is
spelled on the managed providers.

### The one migration you have to write by hand

Prisma has no concept of a publication, so nothing in `prisma migrate` will ever emit this. pgbase
cannot create it for you either: `CREATE PUBLICATION ... FOR ALL TABLES` requires superuser, which
most production databases deliberately withhold from the application role. So it goes in a
migration you write once:

```sql
-- prisma/migrations/<timestamp>_pgbase_publication/migration.sql
CREATE PUBLICATION pgbase FOR ALL TABLES;
```

`FOR ALL TABLES` rather than a table list means a model added later is live automatically, with no
second place to remember. If you cannot grant superuser even once, list the tables instead —
`CREATE PUBLICATION pgbase FOR TABLE "jobs", "tasks"` needs only ownership of those tables.

Never give the publication a column list. Postgres accepts the DDL and then blocks every `UPDATE`
and `DELETE` on any table that is also `REPLICA IDENTITY FULL`, so pgbase rejects the combination at
boot rather than letting you discover it at write time.

With `live` configured, boot fails with the exact statement to run if the publication is missing, so
a forgotten migration is a startup error, never a silently dead subscription. A reads-only
deployment never opens a replication connection and doesn't need the publication at all.

**PostgreSQL 15 or newer.** Boot-time schema resolution reads `pg_publication_rel.prattrs`, and
that column arrived with publication column lists in PG 15. The dev image is 16.

**Nothing else is a prerequisite.** No extensions — `citext` is detected and handled if a column
uses it, never required. No superuser on the read path. And in particular **no native Postgres
RLS**: a policy's `rls` predicate is compiled into the query and evaluated in-process, and
`CREATE POLICY` is deliberately not used — logical decoding bypasses RLS entirely, so native
policies would contribute nothing to the live path and would cost the routing keys the compiled
predicate provides. Generating `CREATE POLICY` from the same registry as
defense-in-depth is a roadmap item, not a requirement.

Every model needs a **primary key**. Boot fails on a table without one — a row with no identity
can't be tracked across a WAL stream.

### One-shot reads

A `Pool` whose role can `SELECT` the application tables. Boot resolution reads `pg_class`,
`pg_attribute`, `pg_constraint`, and `pg_publication_rel`, all world-readable. Nothing to enable,
on any provider.

### Live subscriptions — what the WAL leader needs

Everything here is checked when the leader starts, which happens only if you passed `live` to the
module (step 4). Four things beyond the settings in step 1.

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
full-row updates and unfilterable deletes.

**One case where the default changes behaviour, not just cost.** A `remove` names a row's primary
key, so sending one to a subscriber who may not read that row would disclose its existence and the
timing of writes to it. Deciding whether a `remove` is a legitimate eviction or a disclosure means
knowing whether that subscriber held the row _before_ the change — and only a pre-image can say.

So with `FULL`, a row moved out of a subscriber's RLS scope is evicted exactly. Without it, the
router stays silent: the subscriber keeps a stale copy of a row it legitimately received earlier
until its next reconnect, and no key belonging to another tenant is ever named. Deletes are the
exception — with no post-image to judge by either, the `remove` is sent, because rows that stay on
screen after being deleted is the worse failure. `FULL` removes that case too.

If a table's RLS columns are mutable — anything that can be re-parented across tenants — set
`FULL` on it. Never combine `FULL` with a column-list publication —
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

| Import                     | Contents                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------- |
| `@dltech/pgbase/nest`      | `PgbaseModule`, `PgbaseReadService`, `ScopedPrismaToken`, the live gateway              |
| `@dltech/pgbase/client`    | `createClient`, `liveQueryEndpoint`, `isLiveSerializable`, `PgbaseWireCodec`            |
| `@dltech/pgbase/react`     | `useLiveQuery`                                                                          |
| `@dltech/pgbase/policy`    | `definePolicy`, `NO_CLIENT_ACCESS`, `PolicyRegistry`, validation                        |
| `@dltech/pgbase/context`   | `ClaimsBuilder`, the claims cache, scoped-write assertions                              |
| `@dltech/pgbase/query`     | the query AST, `normalize`, `evaluate`, `compileSql`                                    |
| `@dltech/pgbase/read`      | read scoping, result plans, the wire codec                                              |
| `@dltech/pgbase/schema`    | `PgCatalogSchemaProvider` and resolved-schema types                                     |
| `@dltech/pgbase/wal`       | `createWalLeader`, the pgoutput decoder, change/resync events                           |
| `@dltech/pgbase/live`      | the live subscription protocol, registry, router, and sink shared by gateway and client |
| `@dltech/pgbase/transport` | the change transport (Postgres `NOTIFY` / Redis fan-out) and its codec                  |
| `@dltech/pgbase`           | _empty_ — the root entry exports nothing; import from a subpath                         |

The package also ships the `pgbase` binary, which is what `provider = "pgbase"` in a generator
block resolves to.

`query` is dependency-light on purpose: the same `evaluate` runs on the server against WAL tuples,
and is meant to run in the browser too, to fan one socket-level subscription out to many component
queries. Only the server half is wired up today — a client currently opens one subscription per
query.

## The example app

[`examples/`](examples/README.md) is a small run queue — a NestJS API and a Next.js front end —
where every list on screen is a live subscription. It is the end-to-end reference for everything
above: policies, claims, the scoped client, `useLiveQuery`, and the RTK Query binding.

```bash
pnpm example:up      # postgres with wal_level=logical
pnpm example:seed    # migrate + seed two orgs
pnpm example:api     # :3001
pnpm example:web     # :3000
```

Open it in two windows to watch one window's writes land in the other, and switch the second
window to a user in a different org to watch them not.

## Scripts

- `pnpm build` — dual CJS/ESM build via tsup, including the `.d.ts` / `.d.mts` declaration trees
- `pnpm dev` — watch mode
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm test` — vitest (needs the test database: `pnpm example:up`)
- `pnpm changeset` — record a pending release note and its semver bump
- `pnpm release` — apply pending changesets: bump the version, rewrite `CHANGELOG.md`
- `pnpm example:up` / `example:down` — docker compose; brings up both the example database
  (`:55432`) and the test database (`:55433`)
- `pnpm example:seed` — migrate and seed the example database
- `pnpm example:api` / `example:web` — run the example NestJS API and Next.js front end

The build depends on `@swc/core`. tsup only honours `emitDecoratorMetadata` when it can resolve it,
and degrades to a warning otherwise — without it the package ships providers Nest cannot resolve,
since `design:paramtypes` is how constructor injection finds its types.

## Releasing

Development happens directly on `main`. Pushing to `main` never publishes on its own — `main` is
kept continuously releasable, and a **version-bump commit** is what triggers a release.

```bash
pnpm changeset                                  # describe the change, choose patch/minor/major
pnpm release                                    # apply pending changesets -> version + CHANGELOG
git commit -am "chore(release): v1.1.0"
git push                                        # this is the release
```

`.github/workflows/publish.yml` runs on every push to `main` and every PR against it, in two jobs.
`verify` typechecks and runs the suite against the real compose services. `publish` runs only on a
push to `main`, and only after `verify` passed on that same commit: it compares `package.json`'s
version against the git tags, exits if that version is already tagged, and otherwise packs a real
tarball, validates it, publishes to npm with provenance, tags `v<version>`, and opens a GitHub
release. `.github/workflows/changeset-check.yml` is a separate gate that requires a changeset on
`feat/*` PRs; committing straight to `main` is unaffected by it.

The tarball is validated with [`publint`](https://publint.dev) and
[`arethetypeswrong`](https://arethetypeswrong.github.io) before publishing, because the failures
that matter most here are invisible to the test suite: a malformed `exports` map, a subpath whose
types resolve locally but not from an installed package, or declaration files missing from the
artifact entirely.

### Prereleases

npm packages have no staging environment; the equivalent is a dist-tag. To soak a change inside a
real consuming project before it becomes the default install:

```bash
pnpm changeset pre enter next   # subsequent releases publish as 1.1.0-next.N under the `next` tag
pnpm changeset pre exit         # back to normal releases on `latest`
```

Consumers opt in with `pnpm add @dltech/pgbase@next`. Nobody running a plain
`pnpm add @dltech/pgbase` is affected until the version is promoted to `latest`.

### Publishing credentials

The workflow publishes via [trusted publishing](https://docs.npmjs.com/trusted-publishers): the
`id-token: write` permission lets pnpm exchange a GitHub OIDC token for short-lived npm
credentials, so there is no `NPM_TOKEN` secret to store, rotate, or leak.

That trust is configured in the package's npm settings against **this repository and the
`publish.yml` filename**, so renaming the workflow file breaks publishing until npm is updated to
match. The `name:` inside it is free to change.

## License

MIT
