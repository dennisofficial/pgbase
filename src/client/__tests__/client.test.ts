import { createServer, type Server as NodeHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AsyncLocalStorageContextStore,
  MemoryClaimsCache,
  type ClaimsBuilder,
  type ContextStore,
} from '../../context/index.js';
import { createFakePrisma } from '../../nest/__tests__/fake-prisma.js';
import { PgbaseLiveRuntime, type PgbaseLiveRuntimeOptions } from '../../nest/live-runtime.js';
import { PgbaseReadService } from '../../nest/read-service.js';
import type { Resolved } from '../../nest/tokens.js';
import type { PgbaseModuleOptions } from '../../nest/types.js';
import { definePolicy } from '../../policy/define.js';
import { validatePolicies } from '../../policy/index.js';
import { PgbaseWireCodec, type WireCodec } from '../../read/index.js';
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
import { createClient, type LiveSocket, type Subscription } from '../index.js';

const TABLE = 'pgbase_client_widgets';
const PUBLICATION = 'pgbase_client_widgets_pub';
const SLOT = 'pgbase_client_widgets_slot';
const DEV_HEADER = 'x-pgbase-dev-user';
const PREFIX = 'pgbase';

interface Claims {
  readonly tenant: string;
}
interface Row {
  readonly id: number;
  readonly tenant: string;
  readonly status: string;
}
interface Models {
  readonly ClientWidget: Row;
}

const widgetPolicy = definePolicy<Row & { secret: string }, Claims>('ClientWidget')({
  omit: ['secret'],
  rls: (claims) => ({ tenant: claims.tenant }),
});

function principalFrom(headers: Record<string, unknown> | undefined): string {
  const raw = headers?.[DEV_HEADER];
  const userId = Array.isArray(raw) ? raw[0] : raw;
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error(`missing "${DEV_HEADER}" header`);
  }
  return userId;
}

function getPrincipal(req: unknown): string {
  const like = req as { headers?: Record<string, unknown>; auth?: Record<string, unknown> };
  return principalFrom({ [DEV_HEADER]: like.headers?.[DEV_HEADER] ?? like.auth?.[DEV_HEADER] });
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

function attachReadEndpoint(
  httpServer: NodeHttpServer,
  reads: PgbaseReadService,
  contextStore: ContextStore,
  wire: WireCodec,
  claims: MemoryClaimsCache,
): void {
  httpServer.on('request', (req, res) => {
    if (req.method !== 'POST' || req.url !== `/${PREFIX}/read`) return;
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      void (async () => {
        try {
          const principal = principalFrom(req.headers as Record<string, unknown>);
          const claimsValue = await claims.get(principal);
          const { model, args } = JSON.parse(body);
          const result = await contextStore.run({ principal, claims: claimsValue }, () =>
            reads.read(model, args),
          );
          const payload = JSON.stringify(wire.serialize(result));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(payload);
        } catch (err) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      })();
    });
  });
}

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
  const claims = new MemoryClaimsCache(new StaticClaimsBuilder());
  const wire = new PgbaseWireCodec();
  attachReadEndpoint(httpServer, reads, contextStore, wire, claims);

  const opts: PgbaseLiveRuntimeOptions = {
    httpServer,
    pool,
    schema: resolved.schema,
    policies: resolved.policies,
    reads,
    contextStore,
    claims,
    wire,
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

async function waitForLsn(runtime: PgbaseLiveRuntime): Promise<void> {
  const before = runtime.stats.lastLsn;
  await waitFor(() => runtime.stats.lastLsn !== before, 10_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitForRows(sub: Subscription<unknown>, count: number): Promise<void> {
  await waitFor(() => sub.getSnapshot().length === count, 5_000);
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

describe('createClient', () => {
  it('never opens a socket until a live query actually runs — safe to build at module scope', async () => {
    let socketsCreated = 0;
    const db = createClient<Models>({
      baseUrl: 'http://unused.invalid',
      createSocket: () => {
        socketsCreated++;
        return { connected: false, on: () => {}, off: () => {}, emit: () => {} };
      },
    });

    expect(socketsCreated).toBe(0);
    void db.ClientWidget.createSubscription(); // still detached, per the RTK-style contract
    expect(socketsCreated).toBe(0);

    db.$dispose();
  });
});

describe('createClient over a real runtime', () => {
  it('reads over HTTP and subscribes over the socket, both authenticated from one getAuth', async () => {
    const { runtime, baseUrl } = await startRuntime();
    const db = createClient<Models>({
      baseUrl,
      getAuth: () => ({ [DEV_HEADER]: 'client-tenant' }),
    });

    try {
      await pool.query(`INSERT INTO "${TABLE}" VALUES (1,'client-tenant','ACTIVE','shh')`);

      const found = await db.ClientWidget.findMany({ where: { status: 'ACTIVE' } });
      expect(found).toEqual([{ id: 1, tenant: 'client-tenant', status: 'ACTIVE' }]);
      // `omit: ['secret']` at the transport boundary — the client never sees it, over HTTP or socket.
      expect(found[0]).not.toHaveProperty('secret');

      const one = await db.ClientWidget.findOne({ where: { id: 1 } });
      expect(one).toEqual({ id: 1, tenant: 'client-tenant', status: 'ACTIVE' });

      const sub = db.ClientWidget.createSubscription();
      const rows = await sub.query({ where: { status: 'ACTIVE' } });
      expect(rows).toEqual([{ id: 1, tenant: 'client-tenant', status: 'ACTIVE' }]);

      await pool.query(`INSERT INTO "${TABLE}" VALUES (2,'client-tenant','ACTIVE','x')`);
      await waitForLsn(runtime);
      await waitForRows(sub, 2);
      expect(
        sub
          .getSnapshot()
          .map((r: any) => r.id)
          .sort(),
      ).toEqual([1, 2]);

      sub.close();
      await waitFor(() => runtime.subscriptionCount === 0, 5_000);
    } finally {
      db.$dispose();
      await pool.query(`DELETE FROM "${TABLE}" WHERE id IN (1, 2)`);
      await waitForLsn(runtime);
      await runtime.stop();
    }
  }, 30_000);

  it('rejects a client whose getAuth omits the required header, over both transports', async () => {
    const { runtime, baseUrl } = await startRuntime();
    const db = createClient<Models>({ baseUrl, getAuth: () => ({}) });

    try {
      await expect(db.ClientWidget.findMany()).rejects.toThrow();

      const statuses: string[] = [];
      db.$onStatusChange((s) => statuses.push(s.state));
      const sub = db.ClientWidget.createSubscription();
      // The socket never completes its handshake, so the subscribe ack never arrives either — this
      // is exactly the failure mode `$status` exists for: a snapshot that stays empty forever must
      // still be distinguishable from an empty snapshot that answered correctly.
      void sub.query();
      await waitFor(() => statuses.includes('error'), 5_000);
      expect(sub.getSnapshot()).toEqual([]);
      sub.close();
    } finally {
      db.$dispose();
      await runtime.stop();
    }
  }, 30_000);

  it('rebuilds every live subscription from a fresh snapshot on reconnect, never resuming', async () => {
    const { runtime, baseUrl } = await startRuntime();
    let rawSocket: ClientSocket | undefined;
    const db = createClient<Models>({
      baseUrl,
      getAuth: () => ({ [DEV_HEADER]: 'reconnect-tenant' }),
      // The consumer never touches socket.io-client; this test captures it purely to force a
      // reconnect the way a network blip would, which `createSocket` exists to make possible.
      createSocket: (url, opts) => {
        rawSocket = ioClient(url, { ...opts, reconnectionDelay: 50, reconnectionDelayMax: 100 });
        return rawSocket as unknown as LiveSocket;
      },
    });

    try {
      await pool.query(`INSERT INTO "${TABLE}" VALUES (3,'reconnect-tenant','ACTIVE','shh')`);

      const sub = db.ClientWidget.createSubscription();
      await sub.query({ where: { status: 'ACTIVE' } });
      await waitForRows(sub, 1);
      expect(rawSocket).toBeDefined();

      rawSocket!.disconnect();
      await waitFor(() => runtime.subscriptionCount === 0, 5_000);
      await pool.query(`UPDATE "${TABLE}" SET status = 'INACTIVE' WHERE id = 3`);
      await pool.query(`INSERT INTO "${TABLE}" VALUES (4,'reconnect-tenant','ACTIVE','y')`);

      rawSocket!.connect();
      // Content, not just count, has to change: the pre-disconnect snapshot was also length 1, so
      // a wait keyed on length alone could pass before the resubscribe's fresh snapshot lands.
      await waitFor(() => sub.getSnapshot().some((r: any) => r.id === 4), 5_000);
      expect(sub.getSnapshot().map((r: any) => r.id)).toEqual([4]);

      sub.close();
      await waitFor(() => runtime.subscriptionCount === 0, 5_000);
    } finally {
      db.$dispose();
      rawSocket?.close();
      await pool.query(`DELETE FROM "${TABLE}" WHERE id IN (3, 4)`);
      await waitForLsn(runtime);
      await runtime.stop();
    }
  }, 30_000);

  it('$setAuth switches identity on the live singleton without rebuilding it', async () => {
    const { runtime, baseUrl } = await startRuntime();
    const db = createClient<Models>({ baseUrl, getAuth: () => ({ [DEV_HEADER]: 'tenant-a' }) });

    try {
      await pool.query(`INSERT INTO "${TABLE}" VALUES (5,'tenant-a','ACTIVE','a')`);
      await pool.query(`INSERT INTO "${TABLE}" VALUES (6,'tenant-b','ACTIVE','b')`);

      // The same subscription instance the app already holds, not a new one made for tenant-b.
      const sub = db.ClientWidget.createSubscription();
      await sub.query({ where: { status: 'ACTIVE' } });
      await waitForRows(sub, 1);
      expect(sub.getSnapshot().map((r: any) => r.id)).toEqual([5]);

      db.$setAuth({ [DEV_HEADER]: 'tenant-b' });
      await waitFor(() => sub.getSnapshot().some((r: any) => r.id === 6), 5_000);
      // Reconnect is a fresh connection, not a merge — tenant-a's row is gone from this snapshot.
      expect(sub.getSnapshot().map((r: any) => r.id)).toEqual([6]);

      sub.close();
      await waitFor(() => runtime.subscriptionCount === 0, 5_000);
    } finally {
      db.$dispose();
      await pool.query(`DELETE FROM "${TABLE}" WHERE id IN (5, 6)`);
      await waitForLsn(runtime);
      await runtime.stop();
    }
  }, 30_000);
});
