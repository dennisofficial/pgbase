---
'@dltech/pgbase': minor
---

Cut the setup boilerplate a consuming app has to write, and close one safety hole in the process.

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
