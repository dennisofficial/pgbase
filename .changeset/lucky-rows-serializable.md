---
'@dltech/pgbase': minor
---

Add `isLiveSerializable` to `@dltech/pgbase/client`. Live rows keep the Prisma types they were read with — `bigint`, `Date`, `Decimal`, `Uint8Array` — which RTK's default `serializableCheck` rejects, so every delta into an RTK Query cache entry logged a non-serializable-value error. Pass it as `serializableCheck: { isSerializable: isLiveSerializable }` to widen the check to exactly those types instead of switching it off.
