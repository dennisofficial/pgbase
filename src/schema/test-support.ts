/**
 * Shared test infrastructure for `src/schema/*.test.ts`. Named without a `.test.ts` suffix so
 * vitest doesn't collect it as a test file, but kept under `src/` so it stays inside `rootDir`
 * for `tsc --noEmit`.
 */
import { Pool } from 'pg';

/** Matches `docker-compose.yml`'s `postgres-test` service. Never point this at 55432 (dev). */
export const TEST_DATABASE_URL = 'postgresql://pgbase:pgbase@localhost:55433/pgbase_test';

export function createTestPool(): Pool {
  return new Pool({ connectionString: TEST_DATABASE_URL });
}
