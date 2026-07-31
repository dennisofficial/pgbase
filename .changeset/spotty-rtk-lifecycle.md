---
'@dltech/pgbase': patch
---

Fix `liveQueryEndpoint` being unassignable to an RTK Query endpoint definition. `RtkCacheLifecycleApi` typed `cacheDataLoaded`'s `meta` as `LiveQueryMeta`, but RTK derives that type from the base query — `{}` under `fakeBaseQuery()` — so `build.query(liveQueryEndpoint(...))` failed to compile. `meta` is now `unknown` and narrowed internally.
