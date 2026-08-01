# CLAUDE.md — `src/live/`

Turns one `ChangeEvent` into per-subscription `Delta`s. `registry` indexes subscriptions by model,
`router` decides, `sink` buffers between the WAL leader and the router, `protocol` is the socket
contract, `subscription` is the shared client/server handle.

Every decision here is a **disclosure decision**, not just a correctness one. A `remove` names a
row's primary key, so sending one to a subscriber who may not read that row leaks both the row's
existence and the timing of writes to it. That is why the rules below are asymmetric.

## How a change becomes a delta

`DefaultChangeRouter.routeOne`, in order:

1. **Delete** → emit `remove` if `heldBefore`, else nothing.
2. **Unknown columns** (TOAST-unchanged) intersecting `predicateColumns` → `resync` for that
   subscriber. Undecidable is never guessed.
3. **Predicate matches `newRow`** → `upsert` with the projected row.
4. **No match, and it was an update** → `remove` if `heldBefore`, else silence. An insert that
   doesn't match produces nothing.

Any throw is caught per subscription and downgraded to a `resync` for that one subscriber — one bad
predicate must never take down routing for the others.

## `heldBefore` — the disclosure ladder

This is the subtlest function in the package. It answers "did this subscriber already have this
row?", and falls back in a deliberate order:

1. **Full pre-image available** (`oldRow` non-null and covering every predicate column, i.e.
   `REPLICA IDENTITY FULL`) → evaluate the predicate on it. Exact.
2. **Delete with no pre-image** (`newRow === null`) → `true`, so the `remove` is sent. Rows that
   stay on screen after being deleted is the worse failure, and the key is one the subscriber
   already holds.
3. **Otherwise** → evaluate the **RLS predicate** against the new row. If the row still satisfies
   the subscriber's RLS scope, naming its key discloses nothing new; if it does not, stay silent
   and let the subscriber keep a stale copy until its next reconnect.

Case 3 is why a table whose RLS columns are mutable (anything re-parentable across tenants) should
be `REPLICA IDENTITY FULL`. Do not "improve" it into always sending the `remove`.

Note the two predicates on `Subscription` are separate on purpose: `predicate` is the full
client filter, `rlsPredicate` is the server-authored scope alone. Conflating them breaks case 3.

## Resync is the safe answer

There is no delta stream resumption anywhere in pgbase — a subscriber that cannot be proven correct
is told to refetch. `routeResync` fans an event out to every affected subscription, and
`InMemoryChangeSink` degrades to a resync when its queue exceeds `maxQueued` rather than dropping
events silently. When adding a case where correctness is uncertain, emit a `resync`; never emit a
best-effort `upsert`.

## Adding to the protocol

`Delta` has exactly three kinds (`upsert`, `remove`, `resync`) and they are consumed by both
`src/nest/live-runtime.ts` and `src/client/subscription.ts`. A fourth kind means a wire-format
change on both sides plus the React and RTK bindings — check `protocol.ts` for the event names and
ack shapes before touching either end.

`InMemorySubscriptionRegistry` is per-process; cross-instance fan-out is `src/transport/`'s job,
where only the leader reads the WAL and other instances receive already-decoded changes.
