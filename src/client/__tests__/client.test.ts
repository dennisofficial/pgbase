import { createServer, type Server as NodeHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AsyncLocalStorageContextStore,
  MemoryClaimsCache,
  type ClaimsBuilder,
} from '../../context/index.js';
import { createFakePrisma } from '../../nest/__tests__/fake-prisma.js';
import { PgbaseLiveRuntime, type PgbaseLiveRuntimeOptions } from '../../nest/live-runtime.js';
import { PgbaseReadService } from '../../nest/read-service.js';
import type { Resolved } from '../../nest/tokens.js';
import type { PgbaseModuleOptions } from '../../nest/types.js';
import { definePolicy } from '../../policy/define.js';
import { validatePolicies } from '../../policy/index.js';
import { createWireCodec } from '../../read/index.js';
import { createTestPool } from '../../schema/test-support.js';
import type { ResolvedModel } from '../../schema/types.js';
import { SCHEMA_FORMAT_VERSION } from '../../version.js';
import { resolveSimpleModel, schemaOf } from '../../wal/__tests__/simple-model.js';
import {
  WAL_REPLICATION_CONFIG,
  createPublication,
  dropPublication,
  dropSlotIfExists,
  waitFor,
} from '../../wal/__tests__/support.js';
import { PgbaseClient, type LiveSocket } from '../index.js';

const TABLE = 'pgbase_client_widgets';
const PUBLICATION = 'pgbase_client_widgets_pub';
const SLOT = 'pgbase_client_widgets_slot';
const DEV_HEADER = 'x-pgbase-dev-user';

interface Claims {
  readonly tenant: string;
}
interface Row {
  readonly id: number;
  readonly tenant: string;
  readonly status: string;
  readonly secret: string;
}

const widgetPolicy = definePolicy<Row, Claims>('ClientWidget')({
  omit: ['secret'],
  rls: (claims) => ({ tenant: claims.tenant }),
});

function getPrincipal(req: unknown): string {
  const headers = (req as { headers: Record<string, string | string[] | undefined> }).headers;
  const raw = headers[DEV_HEADER];
  const userId = Array.isArray(raw) ? raw[0] : raw;
  if (!userId) throw new Error(`missing "${DEV_HEADER}" header`);
  return userId;
}

class StaticClaimsBuilder implements ClaimsBuilder<string, Claims> {
  key(principal: string): string {
    return principal;
  }
  async build(principal: string): Promise<Claims> {
    return { tenant: principal };
  }
}

let pool: Pool;
let resolved: Resolved;
let moduleOptions: PgbaseModuleOptions<string, Claims>;

async function startHttpServer(): Promise<{ httpServer: NodeHttpServer; baseUrl: string }> {
  const httpServer = createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const baseUrl = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
  return { httpServer, baseUrl };
}

async function startRuntime(): Promise<{ runtime: PgbaseLiveRuntime; baseUrl: string }> {
  const { httpServer, baseUrl } = await startHttpServer();
  const contextStore = new AsyncLocalStorageContextStore();
  const reads = new PgbaseReadService(moduleOptions, resolved, contextStore);
  const opts: PgbaseLiveRuntimeOptions = {
    httpServer,
    pool,
    schema: resolved.schema,
    policies: resolved.policies,
    reads,
    contextStore,
    claims: new MemoryClaimsCache(new StaticClaimsBuilder()),
    wire: createWireCodec(),
    getPrincipal,
    wal: {
      replicationConfig: WAL_REPLICATION_CONFIG,
      slotName: SLOT,
      publication: PUBLICATION,
      acquireRetryMs: 100,
      statusIntervalMs: 500,
    },
  };
  const runtime = new PgbaseLiveRuntime(opts);
  await runtime.start();
  await waitFor(() => runtime.stats.state === 'streaming', 15_000);
  return { runtime, baseUrl };
}

function newSocket(baseUrl: string, tenant: string): ClientSocket {
  return ioClient(baseUrl, {
    extraHeaders: { [DEV_HEADER]: tenant },
    reconnectionDelay: 50,
    reconnectionDelayMax: 100,
  });
}

function waitConnected(socket: ClientSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (err) => reject(err));
  });
}

async function waitForLsn(runtime: PgbaseLiveRuntime): Promise<void> {
  const before = runtime.stats.lastLsn;
  await waitFor(() => runtime.stats.lastLsn !== before, 10_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** vitest can't `expect.poll` a plain callback store synchronously across sockets, so wait on a
 * condition over the handle's own snapshot instead. */
async function waitForRows(
  handle: { getSnapshot(): readonly unknown[] },
  count: number,
): Promise<void> {
  await waitFor(() => handle.getSnapshot().length === count, 5_000);
}

beforeAll(async () => {
  pool = createTestPool();
  await pool.query(`DROP TABLE IF EXISTS "${TABLE}"`);
  await pool.query(`
    CREATE TABLE "${TABLE}" (
      id integer PRIMARY KEY,
      tenant text NOT NULL,
      status text NOT NULL,
      secret text NOT NULL
    )
  `);
  const model: ResolvedModel = await resolveSimpleModel(pool, 'ClientWidget', TABLE, [
    { name: 'id', required: true },
    { name: 'tenant', required: true },
    { name: 'status', required: true },
    { name: 'secret', required: true },
  ]);
  resolved = {
    schema: schemaOf(model, PUBLICATION),
    policies: validatePolicies(schemaOf(model, PUBLICATION), { ClientWidget: widgetPolicy }),
  };
  moduleOptions = {
    pool,
    prisma: createFakePrisma(pool, model),
    schema: { formatVersion: SCHEMA_FORMAT_VERSION, models: [], enums: [] },
    policies: { ClientWidget: widgetPolicy },
    claimsBuilder: new StaticClaimsBuilder(),
    getPrincipal,
  };
  await createPublication(pool, PUBLICATION, [TABLE]);
}, 60_000);

afterAll(async () => {
  if (pool) {
    await dropPublication(pool, PUBLICATION);
    await dropSlotIfExists(pool, SLOT);
    await pool.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    const { rows } = await pool.query('SELECT slot_name, active FROM pg_replication_slots');
    expect(rows).toEqual([]);
    await pool.end();
  }
});

describe('PgbaseClient over a real runtime', () => {
  it('subscribes, applies live deltas, and rebuilds from a fresh snapshot on reconnect', async () => {
    const { runtime, baseUrl } = await startRuntime();
    const socket = newSocket(baseUrl, 'client-tenant');
    await waitConnected(socket);
    const client = new PgbaseClient({ socket: socket as unknown as LiveSocket });

    try {
      await pool.query(`INSERT INTO "${TABLE}" VALUES (1,'client-tenant','ACTIVE','shh')`);

      const handle = client.liveQuery<{ id: number; status: string }>('ClientWidget', {
        status: 'ACTIVE',
      });
      await waitForRows(handle, 1);
      expect(handle.getSnapshot()).toEqual([{ id: 1, tenant: 'client-tenant', status: 'ACTIVE' }]);

      await pool.query(`INSERT INTO "${TABLE}" VALUES (2,'client-tenant','ACTIVE','x')`);
      await waitForLsn(runtime);
      await waitForRows(handle, 2);
      expect(
        handle
          .getSnapshot()
          .map((r) => r.id)
          .sort(),
      ).toEqual([1, 2]);

      await pool.query(`UPDATE "${TABLE}" SET status = 'INACTIVE' WHERE id = 1`);
      await waitForLsn(runtime);
      await waitForRows(handle, 1);
      expect(handle.getSnapshot().map((r) => r.id)).toEqual([2]);

      // Reconnect: the client should rebuild from a fresh snapshot, not resume.
      socket.disconnect();
      await waitFor(() => runtime.subscriptionCount === 0, 5_000);

      await pool.query(`UPDATE "${TABLE}" SET status = 'ACTIVE' WHERE id = 1`);

      socket.connect();
      await waitConnected(socket);
      await waitForRows(handle, 2);
      expect(
        handle
          .getSnapshot()
          .map((r) => r.id)
          .sort(),
      ).toEqual([1, 2]);

      handle.close();
      await waitFor(() => runtime.subscriptionCount === 0, 5_000);
    } finally {
      client.dispose();
      socket.close();
      await pool.query(`DELETE FROM "${TABLE}" WHERE id IN (1, 2)`);
      await waitForLsn(runtime);
      await runtime.stop();
    }
  }, 30_000);
});
