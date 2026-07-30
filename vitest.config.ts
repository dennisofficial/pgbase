import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Pushes the example app's real migrations onto the port-55433 test database once, before
    // any test file runs (test/global-setup.ts). The resolver suite proves PgCatalogSchemaProvider
    // against that physical fixture, not mocks.
    globalSetup: ['test/global-setup.ts'],
    // The differential property suite (docs/DESIGN.md §4.1) runs against a real Postgres and is
    // the load-bearing correctness guarantee of this package. It is slow by design — do not
    // shorten this without reading that section.
    testTimeout: 30_000,
    // Replication slots/walsenders are a shared, exhaustible resource on the single 55433
    // instance (`max_wal_senders`/`max_replication_slots`, §7.5) — unlike ordinary queries, they
    // don't parallelize as forgivingly. Kept off while `src/wal/**` tests run several leaders per
    // file; every other suite here is fast regardless, so serializing costs almost nothing.
    fileParallelism: false,
  },
});
