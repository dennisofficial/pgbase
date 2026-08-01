# @dltech/pgbase

## 1.0.0

### Major Changes

- 4c42140: Cut the setup boilerplate a consuming app has to write, and close one safety hole in the process.

  - **`publication` is now a single option** on `PgbaseModuleOptions`, read by both the schema
    resolver and the WAL leader. It used to exist in both places, and setting only `live.publication`
    left the resolver pointed at the default — where a publication that does not exist yields no
    `pg_publication_rel` rows, which is indistinguishable from "published, no column list", so the
    `REPLICA IDENTITY FULL` + column-list guard silently stopped running. The resolver now also warns
    when the publication is missing and a table is `REPLICA IDENTITY FULL`.
  - **`connectionString` replaces hand-building a `Pool`.** pgbase builds the catalog pool and closes
    it on shutdown; `pool` still works for a pool you own and is then never ended. `live.replicationConfig`
    defaults to the same connection string, so it only needs setting behind a transaction pooler.
  - **`getPrincipal` receives a normalized `PgbaseRequest`** rather than an Express request in one
    path and a socket.io handshake in the other. `req.credential(name)` reads headers then handshake
    `auth`, so one lookup authenticates both transports — previously a `getPrincipal` written against
    HTTP left every socket connection unauthenticated. Headers, `auth`, `kind`, and `raw` are all
    exposed. **Breaking:** `getPrincipal` now takes `PgbaseRequest`, not `unknown`.
  - **`ScopedRowNotFoundError` maps to 404** in pgbase's exception filter instead of being left to
    the app. Never 403 — a distinct status would confirm the row exists.
  - **The generator emits client row types.** `prisma generate` now writes `models.ts` beside
    `index.ts`: one interface per model plus a `PgbaseModels` map for `createClient<PgbaseModels>()`,
    types-only so a browser bundle pays nothing. Scalars map to what the wire delivers (`bigint`,
    `Date`, `Uint8Array` survive; `Decimal` arrives as `string`). Policy `omit` and `NO_CLIENT_ACCESS`
    are not reflected — the generator runs before policies exist — and must still be subtracted where
    the client is built.
  - **The live gateway warns when shutdown hooks are off.** Without `app.enableShutdownHooks()` the
    leader dies holding its replication slot and every rolling deploy costs a live-update gap of up to
    `wal_sender_timeout`; nothing said so before.

## 0.2.0

### Minor Changes

- 7a193b9: Add `isLiveSerializable` to `@dltech/pgbase/client`. Live rows keep the Prisma types they were read with — `bigint`, `Date`, `Decimal`, `Uint8Array` — which RTK's default `serializableCheck` rejects, so every delta into an RTK Query cache entry logged a non-serializable-value error. Pass it as `serializableCheck: { isSerializable: isLiveSerializable }` to widen the check to exactly those types instead of switching it off.

### Patch Changes

- c8b0e6c: Fix a model being unsubscribable when its policy omits a column its own RLS predicate references. `createSubscription` validated the server-authored RLS predicate against the _client's_ filterable set, so `{ omit: ['actorId'], rls: (c) => ({ actorId: { equals: c.userId } }) }` failed with `Unknown or disallowed filter field "actorId"` — while one-shot reads of the same model worked, since the read path only holds client input to that set. The policy predicate is now checked against the model's fields; the client's own `where` is still restricted to filterable columns, and omitted columns are still stripped from every payload.
- c8b0e6c: Fix `liveQueryEndpoint` being unassignable to an RTK Query endpoint definition. `RtkCacheLifecycleApi` typed `cacheDataLoaded`'s `meta` as `LiveQueryMeta`, but RTK derives that type from the base query — `{}` under `fakeBaseQuery()` — so `build.query(liveQueryEndpoint(...))` failed to compile. `meta` is now `unknown` and narrowed internally.
- efbd875: Fix live deltas carrying WAL comparison types instead of the types a read returns. `decodeColumn` lands values in the shape the comparators want — timestamps as microsecond bigints, `numeric` as a string, a stored JSON null as a sentinel — and the router shipped that row straight to the client, so a row that arrived by delta had `Date` fields that were bigints and disagreed with the same row in the snapshot (`entry.at.toLocaleTimeString is not a function`). Projected rows and remove-keys are now encoded back onto the read path's types at the subscription boundary, which also keeps primary-key identity stable across snapshot and delta. Pass `decimalConstructor` to `PgbaseModule` to have `numeric` deltas arrive as `Decimal` rather than a string.

## 0.1.0

### Minor Changes

- First release published through CI with provenance. Supersedes the manually published `0.0.0`.
