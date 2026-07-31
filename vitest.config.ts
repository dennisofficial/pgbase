import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 30_000,
    // Replication slots/walsenders are a shared, exhaustible resource on the single 55433
    // instance (`max_wal_senders`/`max_replication_slots`, §7.5) — unlike ordinary queries, they
    // don't parallelize as forgivingly. Kept off while `src/wal/**` tests run several leaders per
    // file; every other suite here is fast regardless, so serializing costs almost nothing.
    fileParallelism: false,
  },
});
