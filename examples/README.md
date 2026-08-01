# Opsboard — the pgbase example app

A small run queue for a team: jobs move through `QUEUED → RUNNING → DONE/FAILED`, each with a
checklist. It exists to be driven, not read — every list on screen is a live subscription, so the
interesting part is what happens in a _second_ window while you click in the first.

```bash
pnpm example:up      # postgres with wal_level=logical
pnpm example:seed    # migrate + seed two orgs
pnpm example:api     # :3001
pnpm example:web     # :3000
```

## What to try

Open <http://localhost:3000> in two windows side by side.

| Do this                                        | Watch for                                                                                                                                                                                                                     |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Click **Complete** on a job                    | It leaves the _Running_ column and appears in _Done_ — in both windows. Neither refetched a list; each column is a separate `where: { status }` subscription and the row stopped matching one and started matching the other. |
| Tick a checklist item on a job page            | The same row moves between the two panels, which are `{ done: false }` and `{ done: true }` over one table.                                                                                                                   |
| Tick **Only `labels: { has: "urgent" }`**      | Every column re-subscribes under a new filter and redraws from a fresh server snapshot.                                                                                                                                       |
| Set the second window to **Bob Osei**          | Same org as Alice, so both see the same board — this is the collaborative case.                                                                                                                                               |
| Set it to **Carol Vega**                       | Different org. Alice's writes never reach that window at all: no row, and no delta naming a row id either.                                                                                                                    |
| Click **Start** on a second job                | `409` — `jobs_one_running_per_org` is a partial unique index, so an org can only have one running job. The error is the database's, surfaced rather than hidden.                                                              |
| Delete a job you have open in the other window | That window drops to "Not available" off the delete delta.                                                                                                                                                                    |
| Stop the API, then start it                    | The connection pill goes red and back to green, and every subscription rebuilds from a new snapshot. There is no resumption by design.                                                                                        |

## Where the pieces live

`api/src/` is split so you can tell installation from application. Everything pgbase-specific is
inside `api/src/pgbase/`; every other folder is an ordinary NestJS feature module that happens to
inject `ScopedDb`.

```
api/src/
├── app.module.ts     six imports, one of which is pgbase
├── pgbase/           ← the boilerplate. Copy this folder, adapt policies.ts, done.
├── jobs/  tasks/     the write side: controller + DTOs + service per feature
├── activity/         audit writes, shared by both
├── me/  health/      the two read endpoints the app serves at all
├── config/  common/  env validation; DTO helpers shared across features
└── prisma/           PrismaService — not pgbase's, just Nest's usual Prisma wiring
```

- `api/prisma/models/*.prisma` — the schema. It is deliberately awkward (composite keys, `int8`,
  `Decimal(18,4)`, a self-relation, a table with no tenant column) because it doubles as the
  fixture for this package's own test suite. Read the header comments before changing anything.
- `api/src/pgbase/pgbase.module.ts` — the whole installation: pool, claims, policies, scoped
  client, WAL reader. Start here to see what adopting pgbase actually costs.
- `api/src/pgbase/policies.ts` — one RLS predicate per model, plus the column omissions. This is
  the entire authorization surface; nothing in the app re-checks it.
- `api/src/jobs/`, `api/src/tasks/` — the write side. Validated DTOs, then plain Nest services on
  `ScopedDb`, which is Prisma with each model's RLS predicate already applied. Note that no
  controller publishes anything to a socket, and none of them re-check who the caller is.
- `web/src/app/` — the read side. `useLiveQuery` on the board and job pages; the activity page
  goes through RTK Query instead, over the same subscription machinery.

## What is deliberately not here

- **Auth.** `api/src/pgbase/dev-principal.ts` reads a user id from a header. No session, no token,
  no password. It is the one file you must replace before this is anything but a harness.
- **Response DTOs.** Controllers return scoped Prisma rows directly, which is safe here only
  because `policies.ts` already strips omitted columns — pgbase's answer to output serialization.
  An app with a public API contract should still add response DTOs on top.
- **Read endpoints.** There are none, by design; `/me` exists only to show `ScopedDb` in use.
