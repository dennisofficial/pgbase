# Handoff — `@workspace/nestjs-database` design session

**Date:** 2026-07-29 · **Session type:** design grilling (`/grill-me`), no implementation code written
**Next action:** implement, starting at `DESIGN.md` §13 step 1

---

## What this session was

Dennis is building a **new git submodule package**, `@workspace/nestjs-database`: one package owning
TypeORM + entity registry + RLS + CLS + WAL/CDC engine + query compiler + socket gateway + client
SDK, for a NestJS/Postgres stack. The pattern is **CQS** — backend writes _only_ mutation endpoints;
clients read via a typed SDK over a websocket, inside an RLS envelope they can't influence.

It replaces two existing submodules (`pg-realtime`, `nestjs-rls`). **It is a from-scratch rewrite** —
those are reference material for patterns, explicitly _not_ code to port. Dennis said this directly.

He built a Mongo analogue before: `github.com/dennisofficial/nestjs-realtime-mongo` (abandoned,
public). It put `FilterQuery<T>` straight on the wire — which worked because in Mongo the query
language _is_ the matcher language. That symmetry is the thing Postgres lacks and this package must
manufacture.

---

## Read these, in this order

| File                          | What it is                                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `scratch/DESIGN.md`           | **The authoritative design.** 13 sections + build order + maintainability rules. Start here.                                                  |
| `scratch/fanout.md`           | Connection/fan-out map, mermaid. DB → leader → bus → servers → sockets → components, with multipliers per hop and failure/backpressure paths. |
| `scratch/query-dsl.ts`        | The AST, two interpreters, three divergence hazards, per-repo operator citations, live-vs-one-shot pagination.                                |
| `scratch/claims-cache.ts`     | Dev surface vs package internals, async claims builder, WAL-driven invalidation, revocation cascade.                                          |
| `scratch/rtk-integration.ts`  | Tiering as RTK endpoints, canonicalization, dedupe layers.                                                                                    |
| `scratch/option-{a,b,c}-*.ts` | Superseded by transport tiering. Kept for the reasoning trail.                                                                                |
| `scratch/scratch1.ts`         | Dennis's original 30-min DX sketch. Contains one real bug — see below.                                                                        |

---

## Decisions locked (do not re-litigate without new information)

1. **Capability tiering by transport, not by decorator.** Tier 1 one-shot = nearly full DSL, no
   declaration. Tier 2 live incremental = own-column predicates, no declaration. Tier 3 live+joined
   = explicit per-entity declaration. **Tier 3 is plausibly empty on day one** — the survey found
   essentially every join-shaped demand is one-shot.
2. **Two decorators only: `@Rls` and `@RlsTransform`.** No `@Expose` (transform replaces it), no
   `@Realtime` (every table is realtime — Dennis: "that's the future"), no `@Queryable` unless Tier
   3 materializes.
3. **Secure by default.** Missing `@Rls` ⇒ deny all client access. Missing `@RlsTransform` ⇒ not
   queryable. Column absent from transform output ⇒ never returned _and never filterable_.
4. **Sentinel probe** at boot derives the filterable-column allowlist + column→view-field map from
   each transform. Closes a filter-oracle leak created by dropping `@Expose`.
5. **One AST, two interpreters** (`compile`→SQL, `evaluate`→in-memory), with a differential property
   suite against a real Postgres as the load-bearing correctness guarantee.
6. **Object-literal queries, never strings.** Learned from `postgrest-js`, which pays for a full
   parser _inside the TS type system_ because their query language is a string.
7. **Claims: dev owns caching, package owns invalidation.** `build()` + `sources` on one injectable
   class; `invalidate()` optional (only needed for process-local caches).
8. **Compiler emits structured constraints** (`equalities`/`ranges`/`residual`/`evaluate`), so the
   router is swappable. Equality-bucket router for v1.
9. **The unit of server work is the socket, not the subscription** (§6.2) — union predicate, one
   snapshot per socket per table, client fans out.
10. **Transform runs at the leader**, once globally; the bus carries the _view_, not the raw row, so
    secrets never leave the leader process.
11. **Q4 same-snapshot consistency: yes, as a follow-up.** v1 must not foreclose it — carry LSN on
    every envelope, keep the client apply path batch-shaped.

---

## Empirical findings — these were _measured_, don't re-derive

### Two spikes, run on a throwaway PG 16.14 container (removed afterward; dev DB untouched)

**Spike 1 — publication column lists × `REPLICA IDENTITY FULL` are MUTUALLY EXCLUSIVE.**
DDL accepts either order silently; the failure is at DML time:
`ERROR: cannot update table "t1" / DETAIL: Column list used by the publication does not cover the
replica identity.` It fails **even when the column list names every column**. `INSERT` still works;
`UPDATE`/`DELETE` are blocked. Verified separately that column lists _do_ work with default replica
identity — the excluded column appeared **zero times** in the decoded stream, including on an UPDATE
that changed it. ⇒ per-table Tier A (FULL) / Tier B (column list) choice; boot validation must reject
the combination because it renders a table unwritable. Details in `DESIGN.md` §7.3.

**Spike 2 — publication membership IS dynamic mid-stream.** With a persistent `pg_recvlogical`
walsender, both `ALTER PUBLICATION … ADD TABLE` and `… DROP TABLE` took effect on the in-flight
stream; `pg_replication_slots.active_pid` stayed constant (`160`) across both. ⇒ the leader can
reconcile at runtime without dropping the slot — **and a `DROP` breaks other consumers instantly and
silently**, so expand/contract discipline matters more, not less. Details in §7.4.

Reproduction script: `<scratchpad>/spike2.sh` (scratchpad is session-local; the script is short
enough to rewrite from §7.4 if gone).

### Survey of three of Dennis's production codebases

Read-query shape, `(a)` single-table filter+sort+limit / `(b)` +relation include / `(c)` genuinely
needs joins-aggregates:

| repo               | n   | (a)     | (b)                               | (c) |
| ------------------ | --- | ------- | --------------------------------- | --- |
| `cubix-infra`      | 181 | **90%** | 8%                                | 2%  |
| `rs-crm-app`       | 120 | **67%** | 27%                               | 6%  |
| `ortho-backend-v3` | 189 | **95%** | 0% (impossible — Firestore/Mongo) | 4%  |

The low `(c)` numbers measure _what the stores permit_, not what the apps need — demand shows up as
workaround scar tissue. Key citations worth keeping:

- **The one join capability with real cross-repo demand: filter/sort on a relation's scalar column at
  depth 1.** ortho has **8 distinct two-round-trip workarounds** (incl. `user.service.ts:98-125`, a
  literal users⋈practice join written as two queries); rs-crm has 1 real use + 4 hand-coded junction
  double-hops with JS `Map` dedupe + 4 order-by-joined-column sites.
- **Related-row COUNT** is missing twice over: rs-crm renders three list-row badges as hardcoded `0`
  (`PropertyListRow.tsx:22`, `CompanyListRow.tsx:21-22`); ortho loads entire collections into the
  browser to compute sums.
- **`$ilike` is needed** — rs-crm uses it on 4 read sites; it's the search box on every browse screen.
- **GROUP BY / HAVING / window / DISTINCT ON: zero across all three.** Depth ≥3: zero.
- **rs-crm has no tenancy at all** (zero `org_id`/`tenant_id` hits) — which is why the routing column
  is "highest-selectivity equality column," not "tenant column."
- **rs-crm `_lib/database/paginate.ts:22-24`** ships a client-supplied, unvalidated `ORDER BY` key on
  6 endpoints today. That's the justification for a `sortable` allowlist.
- cubix's only two `Raw()` uses are the same row-value keyset cursor — the one thing that forced an
  escape hatch in 181 read sites.

### Competitor research

**Supabase.** Their realtime path re-`SELECT`s the row **per subscriber per change** (role-
impersonated, via `realtime.apply_rls`). Consequences, from their own docs: ~3,000-subscriber cliff,
single-threaded ordering ("compute upgrades don't meaningfully increase throughput"), **DELETE
unfilterable** (a deleted row can't be re-SELECTed), and no published throughput figure at all — only
an estimator widget. They now steer users to Broadcast (fan-out-once, authorize-at-join). Their filter
grammar is a flat `(column, op, literal)` **array**, which is why they have no OR, no cross-column, no
joins, no casts. **We start on the good side of this divide** — in-process evaluation against the WAL
tuple, zero DB reads per event, and `match(oldRow)` makes DELETE filterable.
Stolen: validate at subscribe time not in the hot path; degrade-don't-drop on oversized payloads;
reject no-PK tables at boot; no client-supplied casts.

**Convex.** Read sets are **interval sets in index-key space** per (table, index), matched by one
shared walk of the commit log (`crates/database/src/reads.rs`, `subscription.rs`). They reject
client-composed queries outright — _"The root problem is that we're exposing the database to the
client, then patching that exposure with row-level rules."_ **That argument is engaged directly in
`DESIGN.md` §1**: their "rules language is separate from app code" leg doesn't apply to us; their
"client can't be trusted with the filter" leg reduces to _registry completeness_, which is why
fail-closed-and-loud is a hard requirement.
Stolen: one-pass routing; result-hash dedup before pushing; the query journal; pinned-cursor
pagination with the valid-prefix invariant; same-snapshot consistency.
Not stolen: no joins/aggregates in the engine (we have SQL), full values on the wire, `.filter()` not
narrowing the read set.

---

## Traps and corrections found along the way

- **TOAST × transform-diffing.** An unchanged TOASTed column is **absent from the WAL even under
  `REPLICA IDENTITY FULL`**. Running the transform naively over that "new row" produces a wrong view
  and a spurious patch claiming the field went null. Carry forward from the old tuple; if absent from
  both, mark unknown and let the client refetch. **Never fabricate `null`.** v1 requirement, and the
  main cost of choosing transform-diffing over column intersection.
- **A naive union saves nothing** (§6.2). `$or: [f1…f20]` costs the same as 20 tests. Needs either a
  conjunct-factoring simplifier or a deliberately coarse two-phase test.
- **Canonicalization is mandatory.** RTK hashes `JSON.stringify(args)`, key-order sensitive, so
  `{a,b}` and `{b,a}` would open two subscriptions for one query. `.build()` emits sorted keys.
- **`ack-query.ts:67`'s `keyOf`** has this exact bug today (`JSON.stringify(arg)`) — reference
  implementation, not to be copied verbatim.
- **Dennis's `scratch1.ts` `wrapEndpoint` has a real bug:** `const sub = client.jobs.createSubscriptionOne()`
  runs once at module load, but RTK creates one cache entry _per distinct arg_. Two args then share
  and stomp one subscription. The fix is a per-arg `Map` inside the endpoint closure (the pattern in
  `ack-query.ts:127`). His mental model (per-arg subscription, subId per cache entry, server routes
  by subId) is correct — the sketch just doesn't express it.
- **Three divergence hazards** between SQL and in-memory evaluation, all silent-wrong-row bugs: type
  fidelity (pgoutput and node-postgres are different decoders — µs vs ms timestamps, arbitrary-
  precision numerics, uuid byte-vs-UTF16 ordering), collation (`ILIKE`/text `ORDER BY`), and
  three-valued logic (`<>` excludes NULLs in SQL, includes them in JS — live at 31 sites across the
  surveyed repos).
- **I initially said cursors were the rarer need.** True for one-shot, false for live: offset
  pagination in a live list is broken by construction. Corrected in `query-dsl.ts`.
- **I initially phrased routing as "(table, index)"**, which implied Firebase-style required index
  declarations. It does not — Postgres's planner picks SQL indexes; routing keys are extracted from
  the predicate automatically.

---

## Dennis's stated preferences from this session

- Wants it **performant above almost everything** — repeatedly steered toward aggregating work so
  servers do less and clients fan out.
- Dislikes stringly-typed model references; wants `client.jobs.*` typed handles.
- Dislikes required-index query APIs (Firebase) — do not reintroduce that shape.
- Wants the dev-facing surface small: one claims class, two decorators, one `forRootAsync`.
- Wants package internals clearly separated from dev responsibilities in docs (an earlier draft
  conflated them and he called it out).
- "Ensure as we build this, the design is solid and easy to maintain later. Use best judgment."

## Still open

See `DESIGN.md` §12. Nothing blocks starting: items 4–6 are v1-ship decisions inside §6.2/§10.1
(union precision, simplifier scope, whether to cache unmatched rows client-side), and 7–9 are
deferred. Items 1–3 are closed by the spikes and the structured-constraints decision.
