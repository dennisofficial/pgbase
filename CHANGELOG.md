# @dltech/pgbase

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
