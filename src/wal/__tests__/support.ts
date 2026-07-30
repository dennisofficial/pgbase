import type { ClientConfig, Pool } from 'pg';
import { TEST_DATABASE_URL } from '../../schema/test-support.js';
import type { WalEvent } from '../types.js';

export const WAL_REPLICATION_CONFIG: ClientConfig = { connectionString: TEST_DATABASE_URL };

export async function createPublication(
  pool: Pool,
  name: string,
  tables: readonly string[],
): Promise<void> {
  await pool.query(`DROP PUBLICATION IF EXISTS ${name}`);
  await pool.query(
    `CREATE PUBLICATION ${name} FOR TABLE ${tables.map((t) => `"${t}"`).join(', ')}`,
  );
}

export async function dropPublication(pool: Pool, name: string): Promise<void> {
  await pool.query(`DROP PUBLICATION IF EXISTS ${name}`);
}

export async function dropSlotIfExists(pool: Pool, name: string): Promise<void> {
  await pool.query('SELECT pg_drop_replication_slot($1)', [name]).catch(() => {});
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10_000,
  stepMs = 20,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

export function collectEvents(leader: {
  on(handler: (event: WalEvent) => void): () => void;
}): WalEvent[] {
  const events: WalEvent[] = [];
  leader.on((event) => events.push(event));
  return events;
}
