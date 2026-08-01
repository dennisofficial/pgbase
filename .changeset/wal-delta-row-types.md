---
'@dltech/pgbase': patch
---

Fix live deltas carrying WAL comparison types instead of the types a read returns. `decodeColumn` lands values in the shape the comparators want — timestamps as microsecond bigints, `numeric` as a string, a stored JSON null as a sentinel — and the router shipped that row straight to the client, so a row that arrived by delta had `Date` fields that were bigints and disagreed with the same row in the snapshot (`entry.at.toLocaleTimeString is not a function`). Projected rows and remove-keys are now encoded back onto the read path's types at the subscription boundary, which also keeps primary-key identity stable across snapshot and delta. Pass `decimalConstructor` to `PgbaseModule` to have `numeric` deltas arrive as `Decimal` rather than a string.
