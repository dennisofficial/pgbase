# `@workspace/nestjs-database` — design

> Status: design settled enough to implement. Written from the grilling session of 2026-07-29,
> the survey of three of Dennis's production codebases (`cubix-infra`, `rs-crm-app`,
> `ortho-backend-v3`), and research into Supabase Realtime + Convex.
>
> **This is a from-scratch package.** The existing `@workspace/pg-realtime` and
> `@workspace/nestjs-rls` are reference material — patterns to steal from, not code to port.

---

## 1. What this is

One package owning everything database-shaped for a NestJS + Postgres + TypeORM app:
TypeORM wiring, the entity registry, row-level security, CLS, the WAL engine, the query
compiler, the socket gateway, and the client SDK.

**The pattern is CQS.** Not CQRS with separate stores — one Postgres, two paths:

```
COMMANDS                                    QUERIES
────────                                    ───────
HTTP → NestJS controller → service          client SDK → socket → query compiler → SQL
imperative authz, business logic            declarative @Rls, no hand-written endpoints
mutations only                              reads only, live by default
```

The backend writes **no read endpoints**. A client asking for data talks to the database
layer directly, inside an RLS envelope it cannot influence.

**Why this split.** Row predicates are good at "which rows may you see" and bad at "may you do
this thing." Reads are uniform and declarative; writes are business logic and belong in
services. Convex's CTO makes the second half of this argument as a reason to reject
declarative row security entirely — the answer is to use it only where it fits.

### The objection, stated fairly

Convex's position (https://stack.convex.dev/why-convex-doesnt-need-row-level-security):

> The root problem is that we're exposing the database to the client, then patching that
> exposure with row-level rules. The alternative is to just not expose the database to the client.

Two legs, one of which reaches us:

- *"The rules language is separate from application code"* — doesn't apply. `@Rls` is
  TypeScript, on the entity, type-checked against `Claims`.
- *"The client can't be trusted with the filter"* — partially applies. The client picks its own
  filter; it is ANDed with a server-derived predicate it cannot influence.

**The residual risk is registry completeness**, and it is the thing this design must engineer
against: a missing policy, a column that shouldn't be queryable, a traversal that reads a table
whose policy never ran. Every one of those must fail closed *and loudly*, never silently.

---

## 2. Declaration surface

Two decorators. No `@Expose`, no `@Realtime`, no `@Queryable`.

```ts
@Entity()
@RlsTransform<Job, JobView>((job) => ({
  id: job.id,
  name: job.name,
  status: job.status,
  createdAt: job.createdAt,
  // derived fields are fine and are the reason this beats a column allowlist
  isStale: job.updatedAt < subDays(job.createdAt, 7),
}))
@Rls<Job, Claims>({
  read: (claims) => ({ orgId: { $in: claims.orgIds } }),
  update: (claims) => ({ orgId: { $in: claims.ownerOrgIds } }),
  create: false,   // server-side unscoped only
  delete: false,
})
export class Job { /* columns */ }
```

### Secure by default, three ways

| Missing | Consequence |
|---|---|
| `@Rls` | **deny all client access.** Not "allow" — absent policy is a closed door. |
| `@RlsTransform` | **not queryable at all.** No transform ⇒ no wire shape ⇒ no exposure. |
| column absent from transform output | never returned, **and never filterable** (§4.3) |

**Silent deny is still a failure mode.** An empty result set looks like "no data," not
"misconfigured," and that's how a whole afternoon disappears. So: deny at runtime with a
*named* error (`no @Rls policy on Job — all client access denied`), plus a boot-time log
enumerating every entity without a policy or transform.

### `@RlsTransform` replaces `@Expose`, and does more

The transform is the schema contract. Consequences:

1. **The client type is `ReturnType<typeof transform>`.** No codegen step, no `.d.ts`
   generation, no staleness check — which is where Supabase's otherwise-good codegen story
   leaks (*"there is no runtime schema check"*, their advice is a scheduled GitHub Action).
2. **Derived fields work.** `isStale`, `fullName`, `deriveHealth()`. A column allowlist can't
   express these, and all three surveyed codebases compute them (cubix's `mapRow` /
   `toPanelServerResponse` / `deriveHealth()`, rs-crm's mappers).
3. **Patches are computed by diffing transform *outputs***, not raw columns: run the transform
   on `oldRow` and `newRow`, diff the two view objects, emit changed view fields. Correct even
   for conditional transforms, which a column-intersection approach gets wrong.

Constraints the transform must obey, validated where possible:
- **Pure and deterministic.** `Date.now()` or `Math.random()` inside a transform makes every
  change look like a change. (Convex hits the same problem from the query side: *"using
  `Date.now()` in a query can cause the Convex query cache to be invalidated more frequently
  than necessary."*)
- **Own columns only.** No relation access — the WAL row is one table.

### The sentinel probe

Run each transform once at boot against a row where every column holds a unique sentinel:

```ts
transform({ id: '⟦id⟧', name: '⟦name⟧', passwordHash: '⟦passwordHash⟧', … })
// → { id: '⟦id⟧', name: '⟦name⟧' }
```

Yields two artifacts from one pass:

1. **The filterable-column allowlist** — columns whose sentinel appears anywhere in the output.
   Conservative by construction: a column that only ever appears under a conditional still
   shows up (safe), one that never appears is hard-blocked (also safe).
2. **The column → view-field map**, for routing and for the publication column list (§7.3).

**This closes a real leak.** Without it, dropping `@Expose` means nothing constrains *filtering*.
`passwordHash` absent from the view but filterable ⇒
`where: { passwordHash: { $prefix: 'a' } }` extracts it one character at a time. The view must
govern what is queryable, not just what is returned.

---

## 3. Capability tiering — by transport, not by decorator

The insight that dissolved a long argument: a one-shot read and a live subscription have cost
regimes that differ by orders of magnitude.

```
one-shot   1 query, once.                          A bad one costs a slow request.
live       1 evaluation per relevant WAL change,    A bad one costs that, forever, × clients.
           for the subscription's lifetime.
```

So they don't get the same capability budget.

| Tier | Transport | Capability | Declaration |
|---|---|---|---|
| **1** | one-shot | nearly the full DSL: relation filters, depth-1/2 include, related counts, order-by-joined-column, offset | none |
| **2** | live, incremental | predicates over the entity's **own columns** | none |
| **3** | live, re-run-on-trigger | joins/aggregates kept live | **explicit, per entity** |

Guardrails for Tier 1 are just RLS + `statement_timeout` + a row cap. Tier 2 is provably cheap:
one predicate evaluation per WAL row, no DB round-trip, ~zero resident state.

### Why this is the cheap answer — the survey data

Every join-shaped demand found across three codebases is **one-shot**:

| Case | Tier |
|---|---|
| ortho `user.service.ts:98-125` — a literal users⋈practice join written as two queries | 1 |
| ortho — the other 7 two-round-trip relation-filter workarounds | 1 |
| rs-crm `contact.controller.ts:196` — junction double-hop + JS `Map` dedupe | 1 |
| rs-crm `order: { activity: { occurred_at } }` ×4 — activity feeds | 1 |
| rs-crm `PropertyListRow.tsx:22` — three hardcoded `0` counts | 1 |
| cubix `backups.service.ts:296` — the one relation filter, redundant anyway | 1 |

What is actually *live* in those products — cubix's servers/nodes lists, rs-crm's thread list —
is single-table or a named server resource.

**⇒ Tier 3 is plausibly empty on day one.** Build Tiers 1 and 2. Add Tier 3's declaration the
first time something genuinely needs a join kept live.

Independent corroboration: PostgREST **disables aggregates by default**, *"because they can
create performance problems without appropriate safeguards."*

---

## 4. The query DSL

### 4.1 One AST, two interpreters

```
compile(ast) → SQL            (parameterized, via TypeORM)
evaluate(ast, row) → boolean  (in-memory, per WAL event)
```

**The invariant:** for every operator and every row `r`,
`evaluate(ast, r) === (r ∈ SELECT * FROM t WHERE compile(ast))`.

Break it and the snapshot disagrees with the live stream, which presents as a flaky UI rather
than an error. This is the load-bearing correctness property of the package.

Mongo got this for free — mingo *is* the Mongo query language, so SQL/in-memory symmetry was
inherent. Postgres has no such symmetry, which is exactly the gap this package closes.

Full AST, operator table with per-repo usage citations, and the three divergence hazards live in
`query-dsl.ts`. Summary:

- **Type fidelity** — pgoutput and node-postgres are *different decoders*. `timestamptz` is µs
  in PG and ms in JS; `numeric` is arbitrary-precision; `uuid` compares by bytes in PG and
  UTF-16 in JS. One shared `decodeColumn(pgType, raw)` plus a per-type comparator. Never bare
  `===` / `<`.
- **Collation** — `ILIKE` and text `ORDER BY` use the DB collation; JS uses neither. `$ilike`
  is included (rs-crm's search bars need it) as `lower(col) LIKE lower($1)`, ASCII-equivalence
  documented. Sorting is restricted to non-text columns, with `COLLATE "C"` as the escape hatch.
- **Three-valued logic** — `status <> 'done'` excludes NULLs in SQL and includes them in JS.
  Negations are rewritten at parse time into explicit NULL handling so neither interpreter has
  to think about it. Live in 31 sites across the surveyed repos.

**The obligation:** a differential property suite against a real Postgres — generate rows and
ASTs, assert the SQL result set equals the in-memory filtered set, shrink to a counterexample.
Every operator passes before it ships. This suite is what makes "the client queries the
database" defensible instead of reckless.

### 4.2 What's in, and why

Operators are justified by usage counts across the three repos, not by completeness.
`$eq $ne $in $nin $lt $lte $gt $gte $between $isNull $like $ilike $prefix $contains`,
plus `$and $or $not` as real tree nodes.

**Keep `$or`.** Supabase can't do it — `realtime.subscription.filters` is a Postgres composite
*array* of `(column, op, value)`, and an array has no alternation node. Every one of their
refusals (no OR, no cross-column, no casts, no joins) falls out of that one storage choice. We
have an actual tree and mingo, so OR is nearly free — and it's used at 10 sites in cubix, 5 in
rs-crm, and hand-rolled as a UNION + JS dedupe in ortho (`user-select-context.tsx:81-120`).

Worth adopting from their list: `match`/`imatch` (POSIX regex) and `isdistinct` (NULL-safe `!=`,
a first-class answer to the three-valued-logic hazard).

**No client-supplied casts.** PostgREST: *"casting on horizontal filtering is not allowed."*
One sentence that removes a class of injection and planner abuse, and it's what makes the
per-type comparator approach sound — the column type alone determines the comparison.

### 4.3 Object literals, never strings

`postgrest-js` implements a full query parser **inside the TypeScript type system**
(`ParseQuery<Str>` → `GetResult<…>`) purely because their query language is a string. The costs
are documented: slow `tsc`, recurring inference bugs (#303, #217), and total collapse to `any`
when the select string isn't a literal type (#327 — `select(someVar)` loses all typing).

We own both ends of the wire. An object-literal query gets identical narrowing from ordinary
generic inference with none of that machinery:

```ts
client.jobs.list({
  where: { status: EJobStatus.OPEN },   // keys ⊆ filterable columns (§2 probe)
  select: ['id', 'name'],              // keys ⊆ view fields
  sort: [['createdAt', 'desc']],
})  // → Pick<JobView, 'id' | 'name'>[]
```

Typed model handles (`client.jobs`) over a `ModelMap`, not `'jobs'` string arguments.

**Canonicalization is mandatory, not cosmetic.** RTK hashes `endpointName + JSON.stringify(args)`,
which is key-order sensitive — `{a,b}` and `{b,a}` would open two subscriptions for one query.
`.build()` emits sorted keys and normalized dates.

---

## 5. Claims

### 5.1 Async policies, resolved once

A policy may **query** to build its filter; the filter it returns must be **static**. That
preserves the one-predicate-two-interpreters invariant.

ortho's `canAccessDoctor` (`appointment.service.ts:155-174`) is the motivating case — a 4-way
disjunction needing a second document read, reimplemented again in `firebase.guard.ts:117-167`
because there was nowhere to put it once. It collapses: resolve the per-(viewer, doctor)
question once into a set, and the entity policy stays `{ doctorId: { $in: claims.visibleDoctorIds } }`.
ortho already proves the collapse works — `appointment.controller.ts:105-124` does exactly this.

What's forbidden: a policy that queries **per row evaluated**. That's one DB read per WAL row
per subscription — precisely Supabase's architecture, and precisely why they hit a wall (§7.1).

### 5.2 Division of labour — dev owns caching, package owns invalidation

```ts
@Injectable()
export class AtlasClaimsBuilder implements ClaimsBuilder<Claims> {
  constructor(private readonly featureFlags: FeatureFlagService) {}   // full Nest DI

  /** Tables that can change these claims + how to find the affected principal from a row. */
  readonly sources = [
    source(OrganizationMember, (row) => row.userId),
    source(User, (row) => [row.id, ...(row.scheduleSharedWith ?? [])]),
  ];

  /** Cache however you like — Redis, LRU, whatever. `fresh` means skip it. */
  async build({ principal, db, fresh }: ClaimsContext): Promise<Claims> { … }

  /** OPTIONAL. Only needed if your cache is process-local — see below. */
  async invalidate(principalId: string): Promise<void> { … }
}
```

The package never chooses your cache, serialization, or TTL. It owns *when*, you own *how*.

**Why `invalidate` has to exist at all:** if you cache inside `build()`, the package calling
`build()` again just gets your stale value back, and nothing appears broken. The package knows
when claims went bad and can fan that across processes; only you know where the copy lives.

- **Redis-backed cache** → `build({ fresh: true })` suffices; the overwrite is globally visible.
  Never implement `invalidate`.
- **Process-local cache** → `invalidate` is required. Otherwise a process holding a stale entry
  serves it on the next REST request even though nobody asked it to rescope. That's an authz
  window, not cosmetic staleness.

The package retains only the per-request CLS memo (it owns the request lifecycle) and §5.4.

### 5.3 Source invalidation

Each `sources` entry becomes a WAL subscription. On a change, map the row → principal ids →
invalidate.

**Map both tuples, old and new.** A membership moved between orgs, or deleted, must invalidate
the principal it *left*. Mapping only `newRow` misses every revocation — the case this exists
for.

**Boot-time check:** every `sources` entity must be in the publication, else invalidation
silently never fires. Fails startup.

### 5.4 Subscription rescoping

Claims resolved at socket connect otherwise never refresh — revoke someone's membership and
their open subscriptions keep streaming rows they can no longer read until they reconnect.
Entirely package-owned:

```
organization_members DELETE
  → affected principal = row.userId
  → builder.invalidate(userId)                 (every process, if implemented)
  → SubscriptionRegistry.rescope(userId)       (the process holding that socket)
```

Asymmetric, and worth implementing as two paths:

- **Scope narrows** — rows to drop are computable from the client's known set. Emit `remove`.
  No query.
- **Scope widens** — newly-visible rows have no WAL event to carry them. Re-snapshot, diff
  against the client's set, emit `add` for the difference.

Either way it's ordinary `add`/`remove` deltas, so the client's normalized cache needs zero
changes. A revocation is indistinguishable from someone else's write removing the row.

---

## 6. Subscription routing

**Not an index the developer declares.** Postgres has a planner; choosing SQL indexes is its
job. This is about a different problem.

Per WAL event the server must answer: *which of my N open subscriptions does this row affect?*
Naive answer is N predicate evaluations — 5,000 subscriptions × 200 writes/sec is a million
evaluations a second.

The discriminator is already in the predicate. Every subscription has the tenant column ANDed
in by RLS, so **extract equality constraints from the compiled predicate** and bucket on them:

```
routing table:   (jobs,    orgId=A) → [sub1, sub7, sub9]
                 (jobs,    orgId=B) → [sub2]
                 (tickets, orgId=A) → [sub3, sub4]

WAL: UPDATE jobs … (row.orgId = A)
  → bucket (jobs, A) → evaluate 3 predicates, not 5,000
```

Derived automatically from the RLS filter. Zero developer-facing concepts. Convex reaches the
same place via declared index intervals (`crates/database/src/reads.rs` — read sets are interval
sets in index-key space, matched by one shared log walk); we get the useful part without
requiring index declarations, which is the thing Firebase gets wrong.

The routing column is **not** necessarily the tenant column. rs-crm has no tenancy at all (zero
hits for `org_id`/`tenant_id`; authz is guard-level). It's *the highest-selectivity equality
column present in nearly every subscription for that table* — `email_account_id` for rs-crm
threads, `customer_id` for cubix panel, `doctor`/`practice_ref` for ortho. Subscriptions lacking
it go in a wildcard bucket that is always tested.

Range predicates would want an interval tree rather than a hash bucket. The survey says ranges are
almost always *secondary* to an equality (`status='held' AND expires_at > now`), so the equality
bucket narrows to a handful first and the range is just evaluated. **Interval trees serve a case
none of the three codebases exhibits** — deferred, gated on profiling.

### 6.1 What must be decided now — structured constraints, not the router

The router itself is swappable. What is *not* swappable later is the **compiler's output type**.

A compiled query must expose its extracted constraints **as data**:

```ts
interface CompiledQuery {
  table: string;
  equalities: Map<string, Scalar>;    // → routing key(s)
  ranges: Array<{ column: string; lo?: Scalar; hi?: Scalar }>;
  residual: Predicate;                // everything the router can't use
  evaluate(row): boolean;             // the fine test
}
```

Hand back only an opaque `evaluate` closure and *any* routing at all becomes a breaking change to
every consumer. Emit structured constraints and equality-buckets → interval-trees → anything else
is purely additive.

**Decision: compiler emits structured constraints (now). Equality-bucket router with a wildcard
bucket (v1). Interval tree only if a hot bucket shows up in profiling.**

### 6.2 The unit of server work is the SOCKET, not the subscription

A client with `jobs status=OPEN` and `jobs status=CLOSED` should cost the server **one** predicate
test, not two, and **one** snapshot query, not two. The client fans out to its own subscriptions.

This is safe precisely at the socket boundary: every subscription on one socket shares one
principal and one claims set, so their union stays inside that client's RLS envelope. Aggregating
*across* sockets would not be safe — different claims.

Four wins, and the fourth is client-side:

1. One predicate test per socket per table instead of one per subscription.
2. **One snapshot query per socket per table** — `WHERE status IN ('OPEN','CLOSED')` once, client
   splits it. This is also the mitigation for the worst load spike in the system (§7.6).
3. One socket emit per row, rather than one per matching subscription (relevant when filters
   overlap).
4. **One row store per table per client**, with subscriptions as filtered *views* over it. Two
   subscriptions on `jobs` currently mean two normalized `Map`s holding duplicate rows and two
   applications of the same patch.

**THE TRAP: a naive union saves nothing.** `$or: [f1 … f20]` costs the same as testing 20
predicates — the evaluator just walks the array. The work moved; it didn't disappear. Two ways to
make it real:

- **A predicate simplifier that factors common conjuncts.** 20 × `orgId=A AND status=X` collapses
  to `orgId=A AND status IN (…)`: one hash lookup instead of 20 evaluations. Mechanical and
  bounded for the DNF shapes the surveyed repos actually produce (top-level OR of ANDs, never
  nested deeper). This is a real component with a real test surface — treat it as such.
- **Or a deliberately coarse two-phase test.** Phase 1: does the row match the socket's *coarse*
  union (e.g. just `orgId=A`)? Most rows fail here and cost one comparison. Phase 2, only for
  survivors: route to specific subIds.

**Phase 2 belongs on the client.** The server emits the row once at socket level; the client
evaluates its own filters and routes to subscriptions. Server cost collapses to one union test per
socket. The client already needs an evaluator for nothing extra — it's the *same* `evaluate` code
as the server, not a third implementation.

The knob this creates: **union precision trades client bandwidth against server CPU.** A coarse
union ships rows no subscription wants. Make it explicit and tunable per deployment rather than
implicit.

What does *not* aggregate: `changedFields` is computed once per event at the leader (§7.6) because
the diff is per-entity, not per-subscription. That path is already maximal.

---

## 7. WAL configuration

### 7.1 The lesson from Supabase

Their realtime path, per WAL record, for **each** subscriber: impersonate the user,
re-`SELECT` the row by PK, apply that subscriber's filters (`walrus` README). Their own docs:

> When you make a single change to a table with 100 subscribed users, Realtime performs 100
> authorization checks — one per user — so throughput scales with the number of subscribers,
> not the write rate. Changes are also processed on a single thread to preserve their order,
> which means larger compute add-ons don't meaningfully increase Postgres Changes throughput.

Every headline limitation follows: a ~3,000-subscriber cliff, single-threaded ordering, and
**DELETE events being unfilterable** — a deleted row can't be re-`SELECT`ed. They publish no
throughput figure for Postgres Changes at all, only an estimator widget, and now steer users to
Broadcast (fan-out-once, authorize-at-join) instead.

**We evaluate predicates in-process against the WAL tuple, zero DB round-trips**, and
`REPLICA IDENTITY FULL` gives `oldRow`, so `match(oldRow)` makes DELETE filterable. We start on
the good side of the exact divide their whole scaling story is about crossing.

### 7.2 Two knobs, and only one matters

| | Paid when | Paid by | Toggle |
|---|---|---|---|
| `REPLICA IDENTITY FULL` | **write time** | every writer, subscribers or not | `AccessExclusiveLock` |
| publication membership | decode time | the leader | DDL, cheaper lock |
| matching subscriptions | per event | the leader | **free — hash lookup** |

`REPLICA IDENTITY FULL` is the real cost and it buys exactly two things: DELETE filtering and
field-level patches. Opt out and a table degrades to full-row updates plus unfilterable deletes
— a well-defined fallback, which is why the opt-out is safe to offer.

**Realtime-by-default, with a static opt-out.** Tier tables from `pg_stat_user_tables` write
rates and row widths — a hot, wide table (fat `jsonb`) keeps default replica identity. Decided
at deploy, not from live subscription counts.

**Not demand-driven.** Toggling on subscribe means flapping `AccessExclusiveLock` on live tables
at unpredictable times, and it breaks subscriptions mid-stream. And "off" saves nothing: an
unconsumed replication slot pins WAL on disk until the volume fills. The cheap dynamic filtering
already lives in the leader, where it's a hash lookup on a decode that was happening anyway.

### 7.3 Publication column lists — SPIKE RESOLVED: incompatible with FULL

**Tested on PostgreSQL 16.14. Column lists and `REPLICA IDENTITY FULL` are mutually exclusive,
and getting it wrong blocks writes.**

The DDL is accepted in any order — `ALTER TABLE … REPLICA IDENTITY FULL` then
`CREATE PUBLICATION … (id, a)` both succeed silently. The failure is at **DML** time:

```
ERROR:  cannot update table "t1"
DETAIL:  Column list used by the publication does not cover the replica identity.
ERROR:  cannot delete from table "t1"
DETAIL:  Column list used by the publication does not cover the replica identity.
```

It fails **even when the column list names every column** (tested: `FOR TABLE t4 (id, a, secret)`
on a 3-column table with FULL → same error). So it isn't a coverage check you can satisfy; with
FULL, the replica identity is "all columns, including ones added later," and any column list is
rejected. `INSERT` still works — only `UPDATE`/`DELETE` are blocked.

What each combination actually does:

| Replica identity | Column list | UPDATE/DELETE | Old tuple | Excluded columns |
|---|---|---|---|---|
| `FULL` | none | ✅ | full old row on UPDATE **and** DELETE | all columns decoded |
| `FULL` | any | ❌ **writes blocked** | — | — |
| default (PK) | includes PK | ✅ | PK only | **never decoded — verified absent from the stream** |
| default (PK) | omits PK | ❌ **writes blocked** | — | — |

Verified: with default replica identity + `(id, a)`, the excluded `secret` column appears **zero
times** in the decoded stream, including on an `UPDATE` that changed it. Column lists do work —
just not with FULL.

**⇒ Per-table choice, and it's a real trade:**

- **Tier A — `FULL`, no column list.** Field-level patches, DELETE filtering. Every column is
  decoded, so secrets reach the leader's memory and are stripped there (§7.6).
- **Tier B — column list, default replica identity.** Excluded columns never leave Postgres. Cost:
  no old tuple beyond the PK ⇒ no patch diffing (full-row updates) and **no DELETE filtering**.

Default to Tier A; Tier B is for tables with a column that must never cross the process boundary
at all, where losing patches and delete filtering is acceptable.

**Boot validation MUST reject `FULL` + column list.** Not as a warning — this configuration makes
the application unable to `UPDATE` that table at all, and the error surfaces at the first write
rather than at startup.

### 7.4 Rollout — SPIKE RESOLVED: membership is fully dynamic mid-stream

**Tested on PostgreSQL 16.14 with a persistent `pg_recvlogical` walsender.** Both
`ALTER PUBLICATION … ADD TABLE` and `… DROP TABLE` take effect on an **in-flight** stream with no
slot recreation and no reconnect — `pg_replication_slots.active_pid` stayed `160` across both
ALTERs, and the stream was never interrupted:

| Phase | Marker | In stream? |
|---|---|---|
| d1 published | `D1_BEFORE` | ✅ |
| after `ADD TABLE d2` | `D2_AFTER_ADD` | ✅ **picked up mid-stream** |
| after `ADD TABLE d2` | `D1_AFTER_ADD` | ✅ (d1 still published) |
| after `DROP TABLE d1` | `D1_AFTER_DROP` | ❌ **stopped mid-stream** |
| after `DROP TABLE d1` | `D2_AFTER_DROP` | ✅ |

So dynamic publication management works, and the leader can reconcile membership at runtime
without dropping the slot or losing its position.

**This makes the expand/contract discipline more important, not less.** A `DROP TABLE` takes
effect *immediately* for the single shared consumer — so a v2 leader that drops a table v1 still
needs breaks v1 instantly, not eventually, and silently (v1 just stops receiving changes for that
table; no error anywhere).

Reconciliation is **additive on boot, subtractive only via an explicit sweep** run when nothing
old is live. During a rolling deploy v1 wants `{a,b}` while v2 wants `{a,b,c}`; if v2's leader
drops something v1 needs, v1 silently stops receiving changes. Union of what all live versions
need.

(Supabase does exactly this — legacy 3-field `filters` kept alive alongside `filters_v2`
specifically so older instances keep working mid-deploy.)

Per deploy: migrate → leader reconciles replica identity + publication → start decoding.
Single-writer via the advisory lock, so concurrent leaders can't fight over DDL.

### 7.5 The CDC pipeline, end to end

Postgres CDC is **not** triggers. It's logical decoding of the write-ahead log.

```
wal_level = logical                          (postgresql.conf — needs a restart)
CREATE PUBLICATION atlas FOR ALL TABLES;     (what may be decoded; optional column lists §7.3)
pg_create_logical_replication_slot('atlas', 'pgoutput');
                                             (a durable WAL position: restart_lsn / confirmed_flush_lsn)
        │
        ▼  START_REPLICATION SLOT atlas LOGICAL <lsn>     ← replication protocol, not SQL
   WALSENDER  decodes WAL → pgoutput messages:
              BEGIN · RELATION · INSERT · UPDATE · DELETE · COMMIT · (STREAM_* if streaming=on)
        │
        ▼   ONE leader process holds the slot (advisory lock — a slot admits one consumer)
   LEADER    decode → normalize row → stamp LSN → serialize ONCE → publish
        │
        ▼   Redis bus
   EVERY SERVER  routing lookup (§6) → candidate subs → evaluate predicate → transform+diff → emit
```

Three obligations that are easy to miss and expensive to discover:

- **The consumer must send Standby Status Updates** with its flushed LSN. Skip it and the slot
  never advances — `pg_wal` grows until the volume fills. Monitor
  `pg_replication_slots.confirmed_flush_lsn` lag as a first-class alert, not an afterthought.
- **A slot admits exactly one active consumer.** That's why there's a leader at all. Everything
  else matches locally off the bus.
- **Decoding is single-threaded per slot, inside the walsender.** This is the throughput ceiling,
  and it's the same one Supabase ran into (§7.1). The leader must do *nothing* but decode,
  normalize, and publish — every predicate evaluation happens downstream.

**Sharding the decode is possible, and it costs the §9 guarantee.** Multiple publications + slots
partitioned by table set decode in parallel, each with its own leader. But two slots are two
independent LSN streams with no cross-stream ordering, so a global same-snapshot flush (§9)
becomes impossible. Decide once: one slot and global consistency, or N slots and per-shard
consistency. Start with one.

**Large transactions are the real robustness hazard.** A bulk migration or a 100k-row backfill
arrives as one `BEGIN … COMMIT` stream and would fan out 100k deltas to every subscriber. Two
defenses:
- `streaming = on` (PG 14+) so in-progress transactions arrive incrementally instead of buffering
  the whole thing in the leader.
- **A large-transaction escape hatch:** above a per-transaction row threshold, stop emitting
  individual deltas and emit one `resync{table}` signal instead. Clients refetch. This is
  Supabase's degrade-don't-drop lesson applied to volume rather than payload size.

### 7.6 Performance budget, and where the wins are

Per WAL event the pipeline costs: decode → normalize → serialize → publish → *(per server)*
route → evaluate → transform → diff → emit. Optimizations in descending value:

1. **Serialize once at the leader, not per subscriber.** The normalized row + LSN is published
   once; nobody re-serializes downstream.
2. **Run the transform once, AT THE LEADER — and publish the view, not the raw row.** The
   transform is per-entity, so its output is identical for every subscriber and every server.
   Doing it at the leader means once globally rather than once per server (4 servers ⇒ 4× less
   transform+diff CPU), and once per event rather than once per subscription — which is the
   natural mistake, since the obvious implementation transforms inside the per-subscription loop.

   ```
   bus payload = { table, pk, op, lsn,
                   filterCols: { old, new },   // probe-marked filterable columns — for predicates
                   view:       { old, new },   // @RlsTransform output — for emission
                   changedFields: string[] }   // the diff, computed once
   ```

   **Security bonus:** a column in no transform output and no filterable set is dropped *before*
   the publish — never in Redis, never in another server's memory, never one bug from a socket.
   That partially recovers what §7.3 lost: since column lists can't coexist with `FULL`, Postgres
   *will* hand the leader every column, so the leader is the next-best strip boundary — one
   process sees raw rows instead of all N.

   Cost: the leader now runs application code in the process that must keep pace with the
   walsender. Transforms are pure single-row functions and must stay cheap (§2 already requires
   purity). If leader CPU becomes the ceiling, move transform+diff to a worker pool *after* the
   decode loop, keeping decode on its own thread.
3. **Routing before evaluation** (§6) — a hash lookup instead of N predicate evaluations.
4. **Result-hash dedup before emitting** — cheap per-subscription state; makes over-invalidation
   free on the wire and free on the client.
5. **Socket-level aggregation** (§6.2) — one union test and one snapshot query per socket per
   table, client fans out.
6. **Coarse bus channels** keyed by table once the server count grows. A single firehose means 20
   servers each process every event even if one cares. Defer until profiling asks.
7. **Bounded per-socket queues with a resync fallback.** A slow client must never stall the
   leader or another client. On overflow, drop the backlog and send `resync` — performance
   isolation, and it reuses the large-transaction path.

### 7.6.1 Scaling asymmetry — the one layer that isn't horizontal

| Layer | Scaling |
|---|---|
| sockets, predicate matching, snapshot queries, fan-out | **horizontal** — add servers |
| **WAL decode + leader transform** | **vertical only**, or shard into N slots — which forfeits §9, since two slots are two unordered LSN streams |

A replication slot admits exactly one consumer and decoding is single-threaded in the walsender.
You cannot add walsenders to one slot. This is the only place where "throw hardware at it" stops
working, and it's why "the leader does nothing but decode, normalize, transform, publish" is a hard
rule rather than a preference.

**Snapshot thundering herd is the worst load spike in the system, and it isn't steady state.** 5,000
subscriptions reconnecting after a deploy is 5,000 snapshot queries in a few seconds. Socket-level
aggregation (§6.2) cuts that to one query per socket per table — the reason that idea is a
robustness feature and not only an optimization. Add jittered reconnect backoff in the client on
top.

⚠️ **TOAST interacts badly with transform-diffing, and this needs handling in v1.**
Postgres stores large values out-of-line, and on `UPDATE` an **unchanged TOASTed column is absent
from the WAL** — even under `REPLICA IDENTITY FULL`. So the "new row" handed to a transform can
be missing a column that didn't change, and naively running the transform over it produces a
*wrong view* and a spurious diff claiming the field went null.

Options, in preference order:
1. Detect the unchanged-TOAST placeholder and carry the value forward from the old tuple — the
   old tuple has it under `REPLICA IDENTITY FULL`, so this is usually sufficient and free.
2. If it's absent from both (INSERT-with-TOAST, or non-FULL table), mark the field *unknown*,
   omit it from the patch, and let the client refetch that row.
3. Never fabricate. Emitting `null` for an absent TOASTed value is a correctness bug that looks
   like data loss.

This is a hard requirement of choosing transform-output diffing over column-set intersection
(§2), and it's the main cost of that choice.

---

## 8. Pagination

Offset and keyset are not interchangeable, and the split is by tier:

| Tier | Mechanism |
|---|---|
| 1 (one-shot) | `offset` is fine — it's what all three repos actually do |
| 2/3 (live) | `after` + a **pinned end cursor**. `offset` is **rejected** |

Offset pagination in a live list is broken by construction: rows shift under the offset and the
client sees duplicates and holes with no way to detect either.

Convex's answer (https://stack.convex.dev/fully-reactive-pagination):

> This switches each page from a limit query (fetch 5 items) into a range query (fetch between
> cursors).

> No matter what happens, the user will see a valid prefix of the list!

On first execution the server resolves the page's end cursor and **stores it per subscription**;
every re-run fetches `(after, endCursor]` as a range instead of `after LIMIT n`. Boundaries never
move, so pages stay adjacent and non-overlapping.

**The price, accepted explicitly: page sizes vary.** A page of 10 becomes 9 when a row inside it
is deleted, 11 when one is inserted. `limit` is a first-execution hint, not an invariant.

Unbounded growth needs a release valve: `pageStatus: 'SplitRecommended' | 'SplitRequired'` +
`splitCursor`, with `maximumRowsRead` bounding work *before* residual filters apply so a page
splits rather than blowing the query budget.

This needs per-subscription server state surviving re-runs — Convex's **query journal**: *"a
serialized representation of decisions made during a query's execution… produced when a query
function first executes and re-used when a query is re-executed."* Generalizes beyond cursors to
anything non-deterministic that must stay stable (sampling, tie-breaks, an "as of" boundary).

Protocol additions: `endCursor`, `pageStatus`, `splitCursor`, `journal`.

---

## 9. Consistency

**Decision: implement the same-snapshot guarantee — as a follow-up, not v1.**

Convex:

> The sync worker additionally guarantees that all queries in the client's query set are at the
> same timestamp. So, components within the UI don't have to worry about anomalies where queries
> execute at different timestamps and are inconsistent.

Without it, a navbar and a detail pane can sit at different LSNs and render contradictory state.
With it, the whole UI is always consistent.

Achievable because every `ChangeEvent` already carries an LSN: buffer deltas per socket, flush
at LSN boundaries, apply in one client pass. Cost is a per-socket buffer plus latency equal to
the flush window.

**v1 obligation: don't foreclose it.** Carry the LSN on every envelope, keep the client's apply
path batch-shaped (accept an array of deltas to apply atomically), and don't let any component
assume immediate per-delta application. Then §9 becomes a server-side change with no protocol
break.

---

## 10. Client SDK

Framework-agnostic core, thin RTK binding. Non-React consumers use the core; the RTK layer is a
subpath export.

**Keep RTK Query.** It already solves refcounting: cache entries are keyed by
`(endpointName, args)`, so a navbar and sidebar issuing the same query share one entry — one
`onCacheEntryAdded`, one subscription. `keepUnusedDataFor` holds the subscription open across
dismount, so navigating away and back doesn't resubscribe or re-snapshot.

**Tier lives in the endpoint definition, not the call site.** `queryFn` = one-shot,
`onCacheEntryAdded` = live, both = the hybrid. Components call `useGetJobsQuery()` and can't
influence the tier — which is what makes fluent-mode selection safe here, since the choice sits
in a reviewed api slice rather than scattered through components.

The hybrid deserves naming as a first-class pattern: **one-shot the expressive joined shape,
then keep only the cheap own-column part live and patch it in place.** Expressive where it's
cheap, incremental where it must be live.

**Three dedupe layers, all needed.**

| Layer | Keyed by | Catches |
|---|---|---|
| RTK Query | `endpointName + serializeQueryArgs(args)` | same endpoint + args, many components |
| `RealtimeClient` refcount | `canonicalize(spec)` | **different** endpoints, identical query |
| socket-level union (§6.2) | `(table)` per socket | many *different* queries on one table → one server-side test + one snapshot |

Without layer 2, `getOpenJobs` and `getJobsForSidebar` — different endpoints, identical query — open
two wire subscriptions for identical server work. Release with a short linger so a remount inside
`keepUnusedDataFor` doesn't churn the socket.

### 10.1 Client architecture under socket-level aggregation

Layer 3 changes the client's internal shape: **one normalized row store per table**, with
subscriptions as filtered views over it.

```
socket ──► per-table store  Map<pk, view>     ◄── the client owns the materialized set
              │
              ├─► sub A  (filter: status=OPEN)   ──► RTK cache entry ──► NavBar, SideBar
              └─► sub B  (filter: status=CLOSED) ──► RTK cache entry ──► Content, Footer
```

On each incoming delta the client applies it **once** to the table store, then re-evaluates only
the subscriptions whose filter references a changed field, then RTK's `selectFromResult` narrows
component re-renders. Three progressively cheaper filters, none redundant.

Consequences to build for deliberately:

- The client needs the **same `evaluate`** the server uses — shared code, not a reimplementation.
  This is why the AST must be plain data and the evaluator isomorphic (§4.1).
- Rows arrive that match *no* subscription when the union is coarse. Store them or drop them, but
  decide explicitly; storing means later subscriptions on that table can sometimes serve from cache.
- Membership transitions (`add`/`remove`) are now derived **client-side** per subscription rather
  than sent per subscription. The server sends "row X changed"; the client decides which of its
  views gained or lost it.

Handle-per-arg, not per-endpoint: the endpoint closure holds a `Map` keyed by canonical arg, and
`queryFn` opens the handle while `onCacheEntryAdded` attaches to the same one and closes it on
`cacheEntryRemoved`. (The natural mistake is one handle per endpoint definition, which two
distinct args then fight over.)

---

## 11. Stolen, with attribution

**Supabase**
- Validate at subscribe time, never in the WAL hot path (they compile/validate regexes at
  subscription creation).
- **Degrade, don't drop** on oversized payloads — `Error 413` retains fields ≤64 bytes so the
  client learns *which row* changed and can refetch. A stub beats silence.
- Reject no-PK tables at boot (`Error 400: no primary key`).
- No client-supplied casts.
- Aggregates off by default, for cost reasons.

**Convex**
- Read set / routing as a keyed structure matched by **one pass** over the change log, rather
  than per-subscription evaluation (§6).
- **Result-hash dedup before pushing.** Cheap per-subscription state that makes over-invalidation
  free on the wire. Especially matters for Tier 3, where a re-run producing identical rows
  should emit nothing.
- The query journal (§8).
- Pinned-cursor pagination + split cursors + the valid-prefix invariant (§8).
- Same-snapshot guarantee across a client's subscriptions (§9).

**Explicitly not copied**
- Convex: no joins/aggregates in the engine (we have SQL — a 32k-doc scan cap plus a JS `reduce`
  is a downgrade), full values on the wire, `.filter()` not narrowing the read set.
- Supabase: per-subscriber authorization, flat-array filters, unfilterable deletes, and no
  gap-filling on reconnect (they never solved it; our answer is re-subscribe → fresh snapshot →
  client reconcile).

---

## 12. Open items

| # | Item | Blocking? |
|---|---|---|
| ~~1~~ | ~~Spike: column lists × `REPLICA IDENTITY FULL`~~ — **RESOLVED (PG 16.14): mutually exclusive; blocks UPDATE/DELETE at DML time. Per-table Tier A/B choice + boot validation.** (§7.3) | closed |
| ~~2~~ | ~~Spike: in-flight publication membership changes~~ — **RESOLVED (PG 16.14): both ADD and DROP take effect mid-stream, same `active_pid`, no slot recreation. Raises the stakes on expand/contract.** (§7.4) | closed |
| ~~3~~ | ~~Routing: equalities vs interval tree~~ — **RESOLVED: the router is swappable; what's fixed now is that the compiler emits STRUCTURED CONSTRAINTS (§6.1). Equality-bucket router for v1.** | closed |
| 4 | **Union precision knob** (§6.2) — how coarse is the per-socket union? Needs a default and a way to tune it | before v1 ship |
| 5 | Predicate simplifier scope (§6.2) — factor common conjuncts into `IN` sets, or coarse two-phase only? | affects §6.2 build |
| 6 | Coarse-union rows matching no subscription — store in the client's table cache or drop? (§10.1) | before v1 ship |
| 7 | Tier 3's declaration syntax — deferred until a real use case exists | no |
| 8 | Transform purity: enforce by lint, by runtime double-execution in dev, or by documentation? | no |
| 9 | Whether `$match`/`$imatch` (regex) earn a place — zero usage in the surveyed repos | no |

## 13. Build order

Each step is independently testable and leaves the package in a working state. Steps 1–4 involve
no WAL and no sockets at all.

1. **AST + `compile` + `evaluate` + the differential property suite.** Nothing downstream is
   trustworthy until this is green. The compiler emits `CompiledQuery` with structured constraints
   from day one (§6.1). (§4.1)
2. **Entity registry, `@Rls`, `@RlsTransform`, sentinel probe, boot validation.** Secure-by-default
   proven by test, not by inspection: unpoliced entity denies, un-transformed entity is invisible,
   non-view column is unfilterable, `FULL` + column list refuses to boot. (§2, §7.3)
3. **CLS + claims builder contract + scoped repositories.** Server-side only, no socket. (§5.1–5.2)
4. **Tier 1 one-shot query path.** Immediately useful on its own — it's what deletes the read
   endpoints. (§3)
5. **WAL leader: decode → TOAST resolve → transform → diff → strip → publish.** Verify against a
   real Postgres; assert secrets are absent from the bus payload. (§7.5, §7.6)
6. **Routing + Tier 2 live subscriptions, per-subscription first.** Correctness before aggregation.
   (§6)
7. **Client SDK + RTK binding**, sharing the `evaluate` from step 1. (§10)
8. **Socket-level aggregation.** Union predicate, unified snapshot, per-table client store,
   client-side fan-out. Deliberately after 6–7 so there's a correct, unaggregated implementation to
   differential-test the aggregated one against. (§6.2, §10.1)
9. **Source invalidation + subscription rescoping.** (§5.3, §5.4)

---

# 14. Amendment — Prisma, the ORM boundary, and the name

> Added 2026-07-29, after the original session. **This section supersedes parts of §2, §4.1,
> §4.2/§4.3, §7.5/§7.6 and §13.** Everything not explicitly amended here still stands.

The original design assumed TypeORM throughout ("One package owning everything database-shaped
for a NestJS + Postgres + TypeORM app", §1). That assumption is now reversed: **the package is
Prisma-first.** This section states why, what it changes, and what it deliberately does *not*
abstract.

**The name is `pgbase`** (`@workspace/pgbase`, `dennisofficial/pgbase`), not
`@workspace/nestjs-database` as written throughout §1–13. Read every occurrence of the old name as
this one. The rename reflects that this is a server *and* client package — a self-hosted Postgres
BaaS — rather than a NestJS-only library; the framework bindings live behind subpath exports
(`/nest`, `/client`, `/react`) instead of in the name.

## 14.1 Why the switch is affordable

Measured against the live Atlas backend, not estimated:

| | count |
|---|---|
| entity files (active, excl. `_old`) | **18**, all in `_lib/database/entities/` |
| files importing `typeorm` | 31 |
| `db.scoped()` / `db.unsafe()` call sites | **28** |
| `InjectRepository` | **0** |
| migrations | 15 files / 938 LOC |
| active backend | 10,270 LOC |

Two facts make this a ~1-day migration rather than a project:

- **Zero direct repository injection.** All data access already funnels through the `Db` facade —
  and *this package replaces that facade*. Those 28 call sites are touched no matter which ORM
  wins, so they are not incremental Prisma cost.
- Atlas is pre-production. 15 migrations squash to one Prisma baseline via introspection.

## 14.2 Why Prisma, on the merits

**1. It converts §1's stated residual risk into a compile error.** §1: *"The residual risk is
registry completeness, and it is the thing this design must engineer against."* `Prisma.ModelName`
is a union generated *from the schema*, so the policy registry can be made exhaustive by the type
checker. TypeORM has no generated name union — the equivalent is a hand-maintained list that
drifts, which is why the original design could only offer runtime fail-closed plus a boot log.
This argument exists on the Prisma side only, and it is the strongest one.

**2. Prisma's `where` is structurally the AST.** Nestable `AND`/`OR`/`NOT`, native `include`,
and `_count` for related-row counts (the three hardcoded `0`s in rs-crm list rows). TypeORM's
find-options cannot nest OR at all — it is a flat object where an array *means* OR, the same
storage limitation §4.2 criticizes Supabase for, and the reason both reference adapters throw
(`pg-realtime/src/typeorm/index.ts:65`).

**3. `@prisma/adapter-pg` runs Prisma on a `pg.Pool` we own** — the same pool used by the Tier 2
snapshot path and the `pg_catalog` probes. One pool, one connection budget. With TypeORM this
means reaching into `dataSource.driver.master` or running two pools.

> **Verified 2026-07-29, and stronger than stated.** In Prisma 7 the `prisma-client` generator is
> **driver-adapter-only** for Postgres — the Rust query engine is gone, and `adapter` is a
> *required* constructor argument, not an option. So this is not a Prisma capability we hope
> consumers opt into; it is the only way a Prisma 7 Postgres app can exist. pgbase can therefore
> **require** a `pg.Pool` at the seam and know the consumer already has one, rather than
> defensively constructing a second pool.

Secondary: Prisma migrate removes both recurring TypeORM-generator irritations (the jsonb
fn-default re-emit loop; the HNSW prune step).

### What this costs, stated plainly

- **Co-location dies — partially recovered, not fixed.** `@Rls`/`@RlsTransform` on the entity class
  becomes a policy file next to the model's service. §2's substantive claim — *the transform is the
  schema contract* — survives intact; *it sits on the entity* does not. This is the design's stated
  ergonomic center and the real price of the switch.

  **Multi-file schemas soften it.** Folder schemas are GA in Prisma 7 (configured by pointing
  `schema` at a directory in `prisma.config.ts`; generator and datasource blocks must live in that
  directory's root `schema.prisma`, with `migrations/` alongside). So a model gets its own
  `prisma/models/job.prisma` beside `src/job/job.policy.ts` rather than a line in one monolith.
  That is two locations instead of TypeORM's one, which is better than five hundred lines instead
  of one — but it is a mitigation, not a fix, and should not be sold as one.

  Two things follow. First, the example app uses a folder schema **deliberately**: consumers will,
  so the generator plugin and `SchemaProvider` must be exercised against that layout or we ship it
  untested. Second, a trap worth knowing — if `schema` is left unset, Prisma silently loads only
  `prisma/schema.prisma` and ignores every model under it, and **`prisma validate` still reports
  success**. That is how an empty schema ships.

  Residual cost: the DMMF carries no source-file provenance, so boot validation can name the model
  (`no policy registered for Job`) but not the file it was declared in.
- **Row-value keyset cursors need `$queryRaw`.** Prisma has no native `(a, b) < ($1, $2)`. Same
  escape-hatch class as TypeORM's `Raw()` today; one bounded piece of the Tier 1 compiler.
- **Prisma is the less boring bet.** The query-compiler / TS-client transition is in motion.
  TypeORM's remaining argument is that it is dull and known.

## 14.3 Amends §2 — the declaration surface is a typed registry, not decorators

Decorators are removed. There is no `@Rls` and no `@RlsTransform`. §2's "two decorators only"
becomes **one `definePolicy` call per model, plus one exhaustive registry.**

```ts
// job.policy.ts — one file per model, beside its service
export const jobPolicy = definePolicy('Job', {
  transform: (job: Job): JobView => ({
    id: job.id,
    name: job.name,
    status: job.status,
    createdAt: job.createdAt,
    isStale: job.updatedAt < subDays(job.createdAt, 7),   // derived fields still work
  }),
  rls: {
    read:   (c: Claims) => ({ orgId: { $in: c.orgIds } }),
    update: (c: Claims) => ({ orgId: { $in: c.ownerOrgIds } }),
    create: false,
    delete: false,
  },
})
```

```ts
// policies.ts — the registry. Exhaustive BY TYPE.
export const policies = {
  Job:            jobPolicy,
  User:           userPolicy,
  OrganizationMember: orgMemberPolicy,
  _PrismaMigration:   NO_CLIENT_ACCESS,   // deliberate opt-out, not an omission
} satisfies { [M in Prisma.ModelName]: PolicyFor<M> }
```

**The `NO_CLIENT_ACCESS` sentinel is the point.** Omission is a `tsc` error, so a new model cannot
reach production without someone *deciding* whether clients may read it. §2's secure-by-default
table is unchanged in effect, but two of its three rows move from runtime to compile time:

| Missing | Original | Amended |
|---|---|---|
| policy for a model | runtime deny + boot log | **compile error** |
| `transform` | not queryable (runtime) | **compile error** (required field) |
| column absent from transform output | never returned, never filterable | unchanged — still the runtime sentinel probe (§2) |

The sentinel probe survives verbatim; it now reads transforms out of the registry instead of off
decorator metadata. Everything in §2 about probe semantics, derived fields, transform purity, and
diffing transform *outputs* is unchanged.

## 14.4 Amends §4.1 — two compile targets, split by tier

§4.1 says `compile(ast) → SQL (parameterized, via TypeORM)`. That single target was wrong; the
tiers have different needs and §3 already separates them.

| Tier | Target | Executed by | Why |
|---|---|---|---|
| **1** one-shot | Prisma `where` / `include` / `orderBy` / `_count` | Prisma client | this is the expressive tier — joins, depth-1/2 includes, related counts. Hand-rolling join aliasing and nested-object assembly is the largest avoidable chunk of work in the package. |
| **2** live | SQL text + params | `pg.Pool` | snapshot is `SELECT … WHERE <union> LIMIT n`; rows are column bags fed straight to the transform. §7.6 explicitly wants no hydration, so there is nothing for an ORM to do. |

The developer writes neither. Both are outputs of the package's compiler; clients still send
object literals, never strings. **The wire vocabulary for both tiers is Prisma's own operator
names — see §14.9, which replaces §4.2's Mongo-style `$eq`/`$in`/`$ilike` set.**

**Consequence worth banking: `evaluate` only ever runs on Tier 2 predicates.** Tier 2 is
own-columns-only by definition (§3), so §4.1's differential property suite — the load-bearing
correctness obligation — covers the own-column operator subset and *not* includes, counts, or
joined-column sorts. That is a materially smaller suite than §4.1 implies.

Escape hatch: `$queryRaw` for the row-value keyset cursor of §8. It is package-internal and never
reachable from the wire.

## 14.5 Amends §4.1 hazard #1 — one decoder, two comparators

Hazard #1 is stated as *"pgoutput and node-postgres are different decoders."* That is only true if
we let it be. Both the WAL path and the snapshot path can parse through **`pg-types`'
`getTypeParser(typeOid)`** — the same registry node-postgres uses. (`@prisma/pulse-cdc-pg` does
exactly this at `PgoutputDecoder.ts:312`.)

What that kills, and what it doesn't:

- **Killed:** reconciling two independent decoders. Same OID → same parser → same JS value.
- **Survives, in full:** JS comparison semantics ≠ Postgres comparison semantics. `Date` is ms from
  a µs source; `numeric`/`int8` arrive as strings; `uuid` compares UTF-16 in JS and bytes in PG;
  `citext` is case-insensitive only in PG.

So `decodeColumn` shrinks to *"use the shared `pg-types` parser"*, and the per-type **comparator**
work stands unchanged. Hazards #2 (collation) and #3 (three-valued logic) are untouched.

## 14.6 The ORM boundary — two internal ports, one deliberate non-port

**Keep, justified with a single ORM:**

- **`SchemaProvider`** → normalized `EntitySchema[]`: model ↔ table, field ↔ column, relations
  (local fields, foreign table, foreign fields, join table). Sourced from Prisma's DMMF.
- **`PolicyRegistry`** → the §14.3 registry, read as data.

These are not swap seams; they are what stops the WAL leader, compiler, router, and gateway from
importing Prisma at all. `pg-realtime` already proves the shape — its entire engine is `pg.Pool`
plus `pg_catalog`, with TypeORM quarantined in one 165-line file.

**Physical column types come from `pg_catalog`, not from the ORM.** Prisma reports `DateTime` +
an optional `@db.` attribute; the comparators of §14.5 need the real `pg_type` OID, and Postgres is
authoritative. `pg-realtime/src/engine/db.ts:resolvePrimaryKey` already reads the catalog this way.
This split removes the most divergence-prone half of the metadata surface.

**Do NOT build a dual-ORM Tier 1 compiler adapter.** Write it directly against Prisma. A port needs
a real swap *and* a live consumer; a TypeORM adapter with no TypeORM consumer is precisely the kind
of speculative port stripped from v3 wholesale. The `SchemaProvider` boundary already means that if
a second ORM ever appears, the Tier 1 compiler is the only ORM-shaped thing to reimplement — the
cheap-to-revisit property, without paying for it now.

## 14.7 Amends §7.5 / §7.6 — CDC transport

`@prisma/pulse-toolkit` (`@prisma/pulse-cdc-pg`, Apache-2.0) was reviewed. **Status: `0.0.0`, two
commits, last 2024-11-06, and Prisma discontinued Pulse in early 2025.** Not a dependency to take.

Two things in it are worth taking as *ideas*:

1. **TOAST carry-forward, already implemented correctly.** `PgoutputDecoder.ts:366` —
   `case 0x75 /*u unchanged toast datum*/: tuple[name] = unchangedToastFallback?.[name]`, with the
   old tuple passed as fallback at line 268. That is §7.6's option 1 verbatim, and it yields
   `undefined` rather than `null` when unavailable — options 2 and 3. Compare what we have today:
   `pg-realtime/src/engine/toast.ts` only *detects* the hole and pays a `refetchOnUpdate` DB
   round-trip. **Carry-forward replaces refetch.** ~15 lines on our existing stack.
2. The `pg-types` decoder sharing of §14.5.

**Decision: keep `pg-logical-replication@2`** (maintained, published, already wrapped by
`replication-source.ts` with transaction buffering, backoff, and at-least-once semantics) and port
the carry-forward fix onto it. Vendor the pulse decoder only if `pg-logical-replication` gets in
the way. Note that neither library handles `STREAM_*`, so §7.5's `streaming = on` for large
transactions is **not** available at v1 — the per-transaction row-threshold `resync{table}` escape
hatch in §7.5 becomes the sole defence against bulk writes, and is therefore mandatory, not
optional.

`pulse-cdc-pg` has zero Prisma dependency and does not bear on §14.2 either way.

## 14.8 SPIKE RESOLVED — how schema metadata is actually obtained

**Run 2026-07-29 against Prisma 7.9.1 on a throwaway PG 16 container. Verdict: NOT BLOCKING, but
the obvious route is dead and the design changes because of it.**

### `Prisma.dmmf` is not usable

| Route | Result |
|---|---|
| `Prisma.dmmf`, new `prisma-client` generator (the default) | **absent entirely** — `'dmmf' in Prisma` is `false` |
| `Prisma.dmmf`, legacy `prisma-client-js` | present but **gutted**: no `nativeType`, no `isId`/`isList`/`isRequired`/`isUnique`, no `relationFromFields`/`relationToFields`, no composite `@@id`, no `uniqueFields`, and **enums come back as an empty array** |
| `getDMMF()` from `@prisma/internals`, parsing schema text | **complete** — every field above present, incl. `nativeType: ["Timestamptz",["6"]]` and correctly-resolved self-relations |

The client-side `Prisma.dmmf` has been progressively thinned across releases for bundle-size
reasons (prisma/prisma#13811, #27349). Building on it is a bet against a documented trend, not a
one-off gap.

### `getDMMF()` works but must not be a runtime dependency

It needs no DB connection and no generated client — it parses `schema.prisma` text. But:

- **3.5 MB of JS plus a 2.8 MB WASM schema parser** (`prisma_schema_build_bg.wasm`), loaded by a
  runtime `fs.readFileSync` relative to `__dirname` that bundlers do not inline. The naive esbuild
  output dies with `ENOENT: … prisma_schema_build_bg.wasm` until the WASM is copied alongside.
- `@prisma/internals` ships the literal description *"This package is intended for Prisma's
  internal use."*

### Decision: a custom Prisma generator, not a boot-time call

**This amends §14.6.** `SchemaProvider` is not built by calling `getDMMF()` at boot. pgbase ships a
**Prisma generator plugin**:

```
prisma generate
  └─ prisma-generator-pgbase   ← receives the full, rich DMMF via onGenerate({ dmmf })
       └─ emits a static, typed EntitySchema[] into the consumer's source tree
```

Runtime then imports a plain generated module. Consequences, all good:

- **Zero `@prisma/internals` at runtime**, zero WASM, bundles anywhere.
- The internal-API exposure moves from production runtime to build time, where a Prisma bump fails
  loudly at `prisma generate` instead of silently at boot.
- It is the same DMMF object `getDMMF()` returns — this is the route the codegen ecosystem
  converged on for #27349.
- **Natural home for the §14.3 registry types.** The generator can emit the `Prisma.ModelName`-keyed
  `PolicyFor<M>` scaffolding alongside the schema, so exhaustiveness is generated rather than
  hand-maintained.

Cost: consumers add a generator block to `schema.prisma` and re-run `prisma generate` on schema
change. That is ordinary Prisma workflow.

Unchanged from §14.6: **physical `pg_type` OIDs still come from `pg_catalog` at boot**, not from
the DMMF. Newly known: the **implicit many-to-many join table** (`_BookToAuthor`) appears in no
DMMF variant at all — it is a schema-level concept Prisma hides — so its physical shape must also
come from `pg_catalog`.

> **Measured 2026-07-30 against the example app.** The join table is physically real
> (`_JobToTag`) and, in Prisma 7, gets a genuine composite primary key (`_JobToTag_AB_pkey`), not
> merely a unique index. Two consequences, both favourable: §7.5's reject-no-PK-tables check does
> not trip on it, and it needs **no** `REPLICA IDENTITY FULL` — for a join table the PK *is* the
> whole row, so default replica identity already delivers a complete old tuple on DELETE. The
> outstanding work is therefore only *discovery* (its name and columns must come from
> `pg_catalog`), not special-case replication handling.

### Incidental finding

Prisma 7 rejects an inline `datasource { url = env(...) }` (`P1012`); the connection URL moved to
`prisma.config.ts` via `defineConfig({ datasource: { url } })`. Affects anyone coming from Prisma 6.

### Prisma Next evaluated and rejected for now — measured 2026-07-30

`prisma-next` 0.16.0 promises exactly what §14.8 wants: a schema compiled to "a deterministic JSON
contract," emitted once and committed. Spiked against this repo's own fixture. **Verdict: NOT YET.**

Disqualifying on its own: **it cannot read a multi-file schema.** `@prisma-next/sql-contract-psl`
hardcodes a single input (`inputs: [schemaPath]`, `resolvedInputs[0]`) with no import or globbing
mechanism. The fixture's five files had to be concatenated by hand.

Three further blockers:

- **The filter grammar is not a serializable tree.** `.where()` takes `(fields, fns) =>
  Expression<Boolean>` — an executable closure AST. The plain-object shorthand is flat,
  equality-only, implicitly ANDed, no per-field operators, no nesting. §14.9's vocabulary decision
  rests on v7's `where` being a nestable JSON tree; none of this can serve that role.
- **`@prisma-next/contract`** — the package we would import — is banner-marked *"Internal package…
  Do not depend on this package directly."*
- **38 breaking changes across 5 minors in ~2 months**, and 0.16.0 changed `contract.json`'s own
  shape (`foreignKeys[]`/`indexes[]` split). Also: implicit m2m cannot be authored at all, `@db.*`
  cannot be inline (must be hoisted to a `types{}` alias), and a bare `enum{}` compiles to `text` +
  a CHECK constraint rather than a native Postgres enum.

**Two findings kept.** First, Prisma Next's architecture *endorses* the §14.8 decision — its
metadata artifact bundles to 59 KB with zero WASM, against `getDMMF()`'s 3.5 MB + 2.8 MB WASM. The
static-emitted-artifact shape is right; we just emit it ourselves. Second, `@prisma-next/driver-
postgres` takes `{ kind: 'pgPool', pool }` — a user-supplied `pg.Pool` — so §14.2's pooling
argument holds across both lines.

Revisit on a stated stability commitment (1.0, or a documented contract-schema guarantee).

## 14.9 Amends §4.2 / §4.3 — one vocabulary, two surfaces

§4.2 invents a Mongo-style operator set (`$eq`, `$in`, `$ilike`, …). **Drop it.** It is a third
query vocabulary — after SQL and Prisma — that nobody on this stack already knows, and it does not
match the ORM the package is now built on. Use **Prisma's own operator names**.

The surfaces then differ by tier, but the *syntax* is identical:

**Tier 1 (one-shot) takes Prisma's args directly.** There is no in-memory matcher on this path —
it is SQL, RLS ANDs in, `statement_timeout` and a row cap bound it. The only work is narrowing the
args to transform-derived view fields. Full expressiveness, generated autocomplete, almost no
compiler. Given §3's survey found essentially every join-shaped demand is one-shot, this is where
the expressiveness win actually lands.

**Tier 2 (live) takes a type-level subset of the same shape.** Not the full `WhereInput`:

```ts
type LiveWhere<M> =
  & { AND?: LiveWhere<M>[]; OR?: LiveWhere<M>[]; NOT?: LiveWhere<M> }
  & { [F in ViewScalarField<M>]?: FieldType<M, F> | LiveFilter<FieldType<M, F>> }

type LiveFilter<T> = {
  equals?: T; not?: T; in?: T[]; notIn?: T[]
  lt?: T; lte?: T; gt?: T; gte?: T
  contains?: string; startsWith?: string; endsWith?: string
  mode?: 'insensitive'          // was §4.2's $ilike; carries hazard #2 unchanged
}
```

### Why Tier 2 cannot just take `Prisma.ModelWhereInput`

This is the most tempting shortcut available and it is the one the Mongo predecessor makes look
free. `nestjs-realtime-mongo` put `FilterQuery<T>` straight on the wire and it worked **because in
Mongo the query language *is* the matcher language** — mingo evaluates `FilterQuery` in memory.
There is no mingo for `Prisma.JobWhereInput`. Three consequences:

1. **No code is saved on the hard half.** You write the in-memory evaluator either way.
2. **The evaluator would owe the whole surface** — `some`/`every`/`none`, nested relation
   traversal, JSON path filters — none of which are evaluable against a single-table WAL row. The
   subset ends up defined by *exclusion*, which is far worse to security-review than inclusion.
3. **The AST is a security boundary and must be CLOSED.** `WhereInput` is a surface Prisma can
   extend in a minor version. A new operator the evaluator doesn't know is either a crash or —
   worse — a filter that means one thing in SQL and another in memory. §4.1's invariant becomes
   un-holdable against a moving target, and the differential suite loses its enumerable domain.

There is also a DX/leak argument: `WhereInput` is generated over *all* model fields, so the types
would autocomplete `passwordHash` while the runtime rejected it. `ViewScalarField<M>` is derived
from the transform (§2's sentinel probe), so the filter-oracle is closed *in the type system*
rather than by a runtime denial.

## 14.10 Native Postgres RLS — rejected for v1, with a roadmap backstop

**One fact decides it: logical decoding bypasses RLS entirely.** Policies are a SELECT-time
construct; the WAL has no notion of them. So on Tier 2 — live subscriptions, the entire point of
this package — native RLS contributes nothing, and the in-memory predicate is still required.

This is not a theoretical objection. It is *the* reason Supabase Realtime doesn't scale. Unable to
evaluate a policy against a WAL tuple, `realtime.apply_rls` re-`SELECT`s each row per subscriber
under role impersonation — which §7.1 traces directly to their ~3,000-subscriber cliff, their
single-threaded ordering, and their unfilterable DELETEs. Native RLS *causes* that architecture.

Three secondary costs:

- **§6 routing dies.** Routing keys are extracted from the compiled predicate. A native policy is
  an opaque `pg_policy.polqual` node tree; recovering equalities means parsing it.
- **Claims are arrays.** `visibleDoctorIds` through `current_setting` means serializing arrays into
  a GUC string and re-parsing them inside every policy, on every query.
- **`SET LOCAL` requires transaction-scoped connections**, constraining pooling.

**Roadmap item, not v1.** Policies are already data in the registry (§14.3), so a *third* emitter —
`compilePolicyToSql()` → `CREATE POLICY` statements in a generated migration — would give
database-enforced defense-in-depth on the SQL path from the same single source of truth, with no
drift. That directly serves §1's fail-closed requirement. Deferred because §4.1's two-interpreter
invariant is already the hardest correctness problem here and a third interpreter triples that
surface. Revisit once the differential suite is green.

**Under no circumstances a replacement for the in-memory matcher** — see the first paragraph.

## 14.11 Transport — why not `@supabase/realtime-js`

Evaluated and rejected. Its `package.json` keywords are `phoenix`, `elixir`: it is the client half
of Supabase's **Elixir** server, speaking the Phoenix Channels wire protocol. Adopting it means
implementing Phoenix Channels *in NestJS* — join/leave/push/reply, refs, join_refs, heartbeats,
topic naming — to replace a socket.io mux + superjson parser that already works
(`pg-realtime/src/socketio/`). That is more code, not less.

It also drags in the format the design exists to beat: `postgres_changes` carries the flat
`(column, op, value)` composite array that §4.2 identifies as the root cause of every Supabase
refusal — no OR, no cross-column, no casts, no joins. Adopting their transport means adopting the
constraint that motivates this package.

Their genuinely good ideas are already stolen in §11. Take those; not the transport.

## 14.12 Amends §13 — build order, in reviewable phases

Each phase is a reviewable unit that leaves the tree green. Phases 1–5 involve no WAL and no
sockets.

**Atlas is NOT the development target and does not move until the end.** pgbase is built against
its own example app; Atlas stays on TypeORM + `pg-realtime`, fully working, and migrates once in
Phase 11. The alternative — migrating Atlas first — was investigated and rejected: `pg-realtime`
reads live TypeORM `EntityMetadata` at runtime (`build-realtime-models.ts` walks
`dataSource.entityMetadatas` for table names, column maps, and PKs), so removing TypeORM before
pgbase can replace it leaves the realtime engine unable to start. Deferring the migration avoids
both a broken middle state and a throwaway port of that metadata layer.

| Phase | Deliverable | Review surface |
|---|---|---|
| **0** | **Example app** — `examples/api` (NestJS) + `examples/web` (Next + RTK) + docker-compose Postgres at `wal_level=logical`, with a deliberately *hostile* schema: composite `@@id`, `@@map`/`@map`, jsonb, native enums, self-relation, implicit m2m, partial unique index, `Decimal`, `BigInt`, `String[]`, `@db.Timestamptz(6)`, tenant column. | the schema — it is also Phase 2's differential-suite fixture |
| **1** | `prisma-generator-pgbase` (§14.8) + `SchemaProvider` + `pg_catalog` type resolution. | the normalized `EntitySchema` shape — everything downstream depends on it |
| **2** | AST + `evaluate` + `compileSql` (Tier 2) + **the differential property suite**. Nothing downstream is trustworthy until this is green. (§4.1, §14.4) | operator coverage; the property-test harness |
| **3** | `definePolicy` + registry + exhaustiveness types + sentinel probe + boot validation (incl. `FULL` + column-list refusal, §7.3). (§2, §14.3) | secure-by-default proven by test, not inspection |
| **4** | CLS + `ClaimsBuilder` contract + claims cache + scoped writes. Server-side only, no socket. (§5.1–5.2) | the four-layer cache; single-flight |
| **5** | **Tier 1 one-shot path** — Prisma compiler for `where`/`include`/`counts`/`orderBy`. Immediately useful on its own; this is what deletes the read endpoints. (§3, §14.4) | the AST → Prisma mapping, and the `$queryRaw` cursor |
| **6** | WAL leader: decode → TOAST carry-forward → transform → diff → strip → publish. (§7.5, §7.6, §14.7) | assert secrets are absent from the bus payload |
| **7** | Routing + Tier 2 live subscriptions, **per-subscription first**. Correctness before aggregation. (§6) | structured constraints; equality-bucket router |
| **8** | Client SDK + RTK binding, sharing `evaluate` from Phase 2. (§10) | per-arg handle `Map`; canonicalization |
| **9** | Socket-level aggregation — union predicate, unified snapshot, per-table client store, client fan-out. Differential-tested against Phase 7. (§6.2, §10.1) | the union simplifier |
| **10** | Source invalidation + subscription rescoping. (§5.3, §5.4) | narrow vs widen paths |
| **11** | **Adopt pgbase in Atlas** — hand-author `schema.prisma` from the 18 entities (introspect only as a cross-check), recreate the DB, and swap TypeORM + `pg-realtime` + `nestjs-rls` for Prisma + pgbase in one cutover. | see the sizing notes below |

Open items §12 items 4–6 land in Phase 9; items 7–9 remain deferred.

### Phase 11 sizing, measured 2026-07-29

Correcting an earlier under-estimate. Atlas's data access is **not** funnelled through one seam:
29 `Db.scoped`/`unsafe` sites (17 trivial / 4 relation / 8 hard) **plus ~19 services injecting
custom `XRepo extends Repository<Entity>` tokens** that bypass `Db` entirely. (`InjectRepository`
greps to zero, which is what made the first reading look smaller than it is.) Realistic: 2–3 days.

The hard parts, specifically:

- **7 `.manager.transaction()` sites.** `job-bootstrap` spans Job + ThreadGroup + Thread +
  InboundMessage in one commit; "never a job without its trigger message" depends on that atomicity.
- **3 `createQueryBuilder` sites using jsonb `->>`** — `$queryRaw` rewrites.
- **`REPLICA IDENTITY FULL` on 10 tables**, applied by two raw-SQL migrations, with no Prisma-schema
  representation. Permanent hand-written SQL, and nothing warns if a later migrate reverts it — the
  §7.3 boot check from Phase 3 is what catches that.
- **Two partial unique indexes** on `agent_credentials` with raw SQL predicates. Prisma cannot
  express partial indexes in-schema.
- **Two parallel config surfaces** (`backend/cli/data-source.ts`, `_lib/database/database.module.ts`)
  plus 5 seed files on raw `DataSource`/`getRepository`. They move together or `db:seed`/`db:migrate`
  break.

The operator surface is reassuringly tiny: `In` ×3, `Not` ×1, `LessThan` ×1, and zero uses of
`IsNull`/`MoreThan`/`Between`/`ILike`/`Raw` anywhere in active code.

Custom constraint naming (`pk_x`, `fk_x_y_z`, `idx_x_y`) has no Prisma equivalent — moot, because
the dev DB is recreated from scratch rather than introspected.
10. **Pinned-cursor pagination + journal.** (§8)
11. **Backpressure + resync:** bounded queues, large-transaction threshold, jittered reconnect.
    (§7.5, §7.6.1)
12. *Follow-up:* same-snapshot consistency across a socket's subscriptions. (§9)

### Maintainability rules for the build

- **One AST, one evaluator, shared by server and client.** The moment there are two evaluator
  implementations the invariant in §4.1 is unverifiable. Package it so the client imports the same
  module.
- **Every operator added to the AST ships with its differential test.** No exceptions — that suite
  is the only thing standing between "the client queries the database" and a data leak.
- **Secure-by-default is a test suite, not a doctrine.** Each of the four fail-closed behaviours in
  step 2 gets an explicit test that would fail if someone "helpfully" made a default permissive.
- **The leader's hot loop stays free of application concerns** beyond transform+diff. If something
  wants to live there, it goes in a worker after the decode loop instead.
- **Aggregation is an optimization layered over a correct base**, never the base itself (step 8
  after 6–7). It must be provable by differential test against the unaggregated path, and
  disableable by config if it ever misbehaves in production.
