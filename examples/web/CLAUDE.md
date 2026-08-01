# CLAUDE.md — `examples/web/`

The Next.js half of Opsboard, and the demonstration that **an app can have zero read endpoints**.
Everything on screen comes from a pgbase live subscription; `src/lib/api.ts` is writes only, and no
write response is used to update the UI — the WAL does that. If you find yourself adding a `GET`
fetch here, the answer is almost always a subscription instead.

## Everything is a client component

Live queries need a socket, so every page carries `'use client'`. Two consequences worth knowing
before adding a page:

- `src/redux/provider.tsx` creates the store **per mount inside a ref**, never at module scope. A
  module-scope store is a singleton shared across requests on the server — the classic RSC + Redux
  trap. That file is the boundary; keep store creation there.
- `src/redux/store.ts` widens `serializableCheck` with `isLiveSerializable` rather than disabling
  it. Live rows legitimately contain `bigint`, `Date`, `Decimal` and `Uint8Array`, which RTK's
  default check rejects. Widen to exactly those; do not switch the check off.

## `src/pgbase/client.ts` is the whole client surface

One `createClient` for the app, plus **hand-written row types** — nothing generates client-side row
types yet, so the `Models` interface is maintained by hand and must mirror `examples/api`'s
policies. The mirroring is load-bearing: `AuditLog` has no `actorId` because the policy omits it
server-side, and `Invoice.amount` is `string` because `Decimal(18,4)` does not survive a JS number.
A type that claims a column the policy strips is a lie the compiler cannot catch.

Identity is a dev stand-in (`DEV_USERS`, a header, per-tab `sessionStorage`). `setCurrentUser` calls
`pgbase.$setAuth` even though the getter is unchanged — re-setting it reconnects the socket, which
resyncs every open subscription under the new claims instead of leaving rows the previous identity
could see. Removing that call is a data leak between users, not a refactor.

## Two ways to subscribe, both shown

`useLiveQuery` on the board and job pages; RTK Query via `liveQueryEndpoint` on the activity page.
They run over the same subscription machinery — the activity page exists to prove the Redux path
works, not because it needs a cache. Changing a `where` closes the old subscription and opens a new
one, so the list redraws from a fresh server snapshot rather than filtering a stale local copy.

Live `where` clauses here are limited to the model's own columns — no `include`, `orderBy`, `take`
or `skip`. Joining across two live queries is done in the browser (see `page.tsx` joining tasks to
jobs); both stay consistent because one WAL stream feeds them.

## Config

`next.config.ts` pins `outputFileTracingRoot` because pgbase is a git submodule inside the atlas
monorepo — without it Next walks up to atlas's `pnpm-lock.yaml` and infers the wrong workspace root.

`NEXT_PUBLIC_API_URL` defaults to `http://localhost:3001`. Run `pnpm example:api` first; the socket
connects lazily on the first live query, so a missing API surfaces as an empty board plus a red
connection pill rather than a boot error.
