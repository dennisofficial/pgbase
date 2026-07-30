import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The differential property suite (docs/DESIGN.md §4.1) runs against a real Postgres and is
    // the load-bearing correctness guarantee of this package. It is slow by design — do not
    // shorten this without reading that section.
    testTimeout: 30_000,
  },
});
