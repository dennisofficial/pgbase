-- Hand-written. Neither of these is expressible in a Prisma schema, so Prisma will never
-- generate them and — more importantly — will never notice if they go missing.
-- See docs/DESIGN.md §7.2, §7.3.

-- ─────────────────────────────────────────────────────────────────────────────
-- REPLICA IDENTITY FULL  (§7.2 Tier A)
-- ─────────────────────────────────────────────────────────────────────────────
-- Buys exactly two things, and the engine is built on both:
--   1. DELETE filtering  — the old tuple is in the WAL, so match(oldRow) works. Without it a
--      deleted row cannot be tested against a subscription's predicate at all (this is the
--      limitation Supabase never solved; §7.1).
--   2. Field-level patches — diffing the transform's output across old/new needs an old row.
-- Paid at WRITE time by every writer, subscribed or not, and toggling it takes an
-- AccessExclusiveLock — hence set once here at deploy, never demand-driven (§7.2).
--
-- MUST NOT be combined with a publication column list: the two are mutually exclusive and the
-- combination blocks UPDATE/DELETE at DML time, even when the list names every column. Boot
-- validation rejects it (§7.3).

ALTER TABLE "orgs"          REPLICA IDENTITY FULL;
ALTER TABLE "users"         REPLICA IDENTITY FULL;
ALTER TABLE "memberships"   REPLICA IDENTITY FULL;
ALTER TABLE "jobs"          REPLICA IDENTITY FULL;
ALTER TABLE "job_settings"  REPLICA IDENTITY FULL;
ALTER TABLE "tasks"         REPLICA IDENTITY FULL;
ALTER TABLE "job_watchers"  REPLICA IDENTITY FULL;
ALTER TABLE "tags"          REPLICA IDENTITY FULL;
ALTER TABLE "threads"       REPLICA IDENTITY FULL;
ALTER TABLE "invoices"      REPLICA IDENTITY FULL;

-- `audit_log` is deliberately LEFT at default replica identity (PK only). It is the fixture for
-- the Tier B degraded path: no old tuple beyond the PK, therefore no patch diffing and no DELETE
-- filtering. The engine must handle that gracefully rather than assuming FULL everywhere, and
-- there needs to be a table in the example that proves it does.

-- ─────────────────────────────────────────────────────────────────────────────
-- Partial unique index
-- ─────────────────────────────────────────────────────────────────────────────
-- Prisma has no syntax for `WHERE` on an index. Atlas has two of these today on
-- agent_credentials, so the example needs one or that translation path ships untested.
--
-- KNOWN CONSEQUENCE: `prisma migrate dev` does not know this index exists and will report the
-- database as drifted, offering to reset. That is not a mistake in this migration — it is the
-- actual cost of raw DDL under Prisma Migrate, and it is better discovered here than during the
-- Atlas cutover.

CREATE UNIQUE INDEX "jobs_one_running_per_org"
  ON "jobs" ("org_id")
  WHERE "status" = 'RUNNING';
