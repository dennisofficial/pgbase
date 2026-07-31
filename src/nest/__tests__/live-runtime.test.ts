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
import { PGBASE_DELTA, PGBASE_SUBSCRIBE, PGBASE_UNSUBSCRIBE } from '../../live/protocol.js';
import type { Delta } from '../../live/types.js';
import { definePolicy } from '../../policy/define.js';
import { validatePolicies } from '../../policy/index.js';
import { createWireCodec, type ReadArgs } from '../../read/index.js';
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
import { PgbaseLiveRuntime, type PgbaseLiveRuntimeOptions } from '../live-runtime.js';
import { PgbaseReadService } from '../read-service.js';
import type { Resolved } from '../tokens.js';
import type { PgbaseModuleOptions } from '../types.js';
import { FakeDecimal, createFakePrisma } from './fake-prisma.js';

const TABLE = 'pgbase_live_gateway_widgets';
const PUBLICATION = 'pgbase_live_gateway_widgets_pub';
const SLOT = 'pgbase_live_gateway_widgets_slot';
const DEV_HEADER = 'x-pgbase-dev-user';

interface Claims {
  readonly tenant: string;
}

interface Row {
  readonly id: number;
  readonly tenant: string;
  readonly status: string;
  readonly score: number;
  readonly amount: unknown;
  readonly bigCount: unknown;
  readonly createdAt: Date;
  readonly secret: string;
}

const widgetPolicy = definePolicy<Row, Claims>('LiveGatewayWidget')({
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

/**
 * Delays exactly between the real snapshot SELECT resolving and the caller receiving it. The
 * seam test uses this to hold a subscription in "buffering" mode for a controlled window,
 * without a timing-dependent race — `waitUntilBlocked()` only resolves once the real query has
 * already run and captured its (pre-insert) result.
 */
class GatedReadService extends PgbaseReadService {
  private release: (() => void) | null = null;
  private started: (() => void) | null = null;

  waitUntilBlocked(): Promise<void> {
    return new Promise((resolve) => (this.started = resolve));
  }

  open(): void {
    this.release?.();
  }

  override async read(model: string, args: ReadArgs): Promise<unknown> {
    const result = await super.read(model, args);
    await new Promise<void>((resolve) => {
      this.release = resolve;
      this.started?.();
    });
    return result;
  }
}

let pool: Pool;
let model: ResolvedModel;
let resolved: Resolved;
let moduleOptions: PgbaseModuleOptions<string, Claims>;
const wire = createWireCodec({ decimalConstructor: (v: string) => new FakeDecimal(v) });

/**
 * A fresh `http.Server` per test — `PgbaseLiveRuntime.stop()` closes the HTTP server it was
 * given (socket.io's `io.close()` does this whenever it was attached to one), which is correct
 * production behavior for a gateway shutting down but means tests can't share one across runtimes.
 */
async function startHttpServer(): Promise<{ httpServer: NodeHttpServer; baseUrl: string }> {
  const httpServer = createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const baseUrl = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
  return { httpServer, baseUrl };
}

function newClient(baseUrl: string, tenant: string): ClientSocket {
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

function emitAck<A>(socket: ClientSocket, event: string, payload: unknown): Promise<A> {
  return new Promise((resolve) => socket.emit(event, payload, (ack: A) => resolve(ack)));
}

interface RowInput {
  readonly id: number;
  readonly tenant: string;
  readonly status: string;
  readonly score: number;
  readonly amount: string;
  readonly bigCount: string;
  readonly createdAt: string;
  readonly secret: string;
}

async function insertRow(row: RowInput): Promise<void> {
  await pool.query(`INSERT INTO "${TABLE}" VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
    row.id,
    row.tenant,
    row.status,
    row.score,
    row.amount,
    row.bigCount,
    row.createdAt,
    row.secret,
  ]);
}

function buildRuntime(
  httpServer: NodeHttpServer,
  reads: PgbaseReadService,
  contextStore: ContextStore,
  readLimits?: { maxRows: number; statementTimeoutMs: number },
): PgbaseLiveRuntime {
  const opts: PgbaseLiveRuntimeOptions = {
    httpServer,
    pool,
    schema: resolved.schema,
    policies: resolved.policies,
    reads,
    contextStore,
    claims: new MemoryClaimsCache(new StaticClaimsBuilder()),
    wire,
    getPrincipal,
    wal: {
      replicationConfig: WAL_REPLICATION_CONFIG,
      slotName: SLOT,
      publication: PUBLICATION,
      acquireRetryMs: 100,
      statusIntervalMs: 500,
    },
    ...(readLimits ? { readLimits } : {}),
  };
  return new PgbaseLiveRuntime(opts);
}

/** Constructs the runtime + its `PgbaseReadService` sharing one `ContextStore`, the way
 * `PgbaseLiveGateway` wires them from the same DI container in a real app — each on its own
 * HTTP server. */
async function harness(): Promise<{
  runtime: PgbaseLiveRuntime;
  reads: PgbaseReadService;
  contextStore: ContextStore;
  httpServer: NodeHttpServer;
  baseUrl: string;
}> {
  const { httpServer, baseUrl } = await startHttpServer();
  const contextStore = new AsyncLocalStorageContextStore();
  const reads = new PgbaseReadService(moduleOptions, resolved, contextStore);
  return {
    runtime: buildRuntime(httpServer, reads, contextStore),
    reads,
    contextStore,
    httpServer,
    baseUrl,
  };
}

async function waitForLsn(runtime: PgbaseLiveRuntime): Promise<void> {
  const before = runtime.stats.lastLsn;
  await waitFor(() => runtime.stats.lastLsn !== before, 10_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeAll(async () => {
  pool = createTestPool();
  await pool.query(`DROP TABLE IF EXISTS "${TABLE}"`);
  await pool.query(`
    CREATE TABLE "${TABLE}" (
      id integer PRIMARY KEY,
      tenant text NOT NULL,
      status text NOT NULL,
      score integer NOT NULL,
      amount numeric(12,2) NOT NULL,
      "bigCount" bigint NOT NULL,
      "createdAt" timestamptz NOT NULL,
      secret text NOT NULL
    )
  `);
  // FULL, as the example app and the docs recommend: evicting a row re-parented across tenants
  // needs the pre-image to prove the subscriber held it. Without one the router must stay silent
  // rather than name another tenant's primary key.
  await pool.query(`ALTER TABLE "${TABLE}" REPLICA IDENTITY FULL`);
  model = await resolveSimpleModel(pool, 'LiveGatewayWidget', TABLE, [
    { name: 'id', required: true },
    { name: 'tenant', required: true },
    { name: 'status', required: true },
    { name: 'score', required: true },
    { name: 'amount', required: true },
    { name: 'bigCount', required: true },
    { name: 'createdAt', required: true },
    { name: 'secret', required: true },
  ]);
  resolved = {
    schema: schemaOf(model, PUBLICATION),
    policies: validatePolicies(schemaOf(model, PUBLICATION), { LiveGatewayWidget: widgetPolicy }),
  };
  moduleOptions = {
    pool,
    prisma: createFakePrisma(pool, model),
    schema: { formatVersion: SCHEMA_FORMAT_VERSION, models: [], enums: [] },
    policies: { LiveGatewayWidget: widgetPolicy },
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

describe('PgbaseLiveRuntime', () => {
  it('subscribe = snapshot + stream: a commit during the snapshot window is neither lost nor duplicated', async () => {
    const { httpServer, baseUrl } = await startHttpServer();
    const contextStore = new AsyncLocalStorageContextStore();
    const gated = new GatedReadService(moduleOptions, resolved, contextStore);
    const runtime = buildRuntime(httpServer, gated, contextStore);
    await runtime.start();
    await waitFor(() => runtime.stats.state === 'streaming', 15_000);

    const client = newClient(baseUrl, 'seam-tenant');
    await waitConnected(client);

    try {
      const blocked = gated.waitUntilBlocked();
      const ackPromise = emitAck<any>(client, PGBASE_SUBSCRIBE, {
        model: 'LiveGatewayWidget',
        where: { status: 'ACTIVE' },
      });
      await blocked; // the snapshot SELECT already resolved (without the row below) and is now paused

      await insertRow({
        id: 9001,
        tenant: 'seam-tenant',
        status: 'ACTIVE',
        score: 1,
        amount: '10.00',
        bigCount: '5',
        createdAt: '2026-01-01T00:00:00Z',
        secret: 'shh',
      });
      await waitForLsn(runtime);

      gated.open();
      const ack = await ackPromise;
      expect(ack.ok).toBe(true);

      const snapshot = wire.deserialize(ack.snapshot) as Array<Record<string, unknown>>;
      expect(snapshot.map((r) => r.id)).toEqual([9001]);
      expect('secret' in snapshot[0]!).toBe(false);
    } finally {
      // Drain before stopping — an unconsumed change left in the slot when a leader stops
      // becomes backlog the NEXT test's leader replays on the same slot.
      await pool.query(`DELETE FROM "${TABLE}" WHERE id = 9001`);
      await waitForLsn(runtime);
      client.close();
      await runtime.stop();
    }
  }, 30_000);

  it('two sockets with different claims see only their own rows; unsubscribe and disconnect both clean up', async () => {
    const { runtime, baseUrl } = await harness();
    await runtime.start();
    await waitFor(() => runtime.stats.state === 'streaming', 15_000);

    const a = newClient(baseUrl, 'rls-a');
    const b = newClient(baseUrl, 'rls-b');
    await Promise.all([waitConnected(a), waitConnected(b)]);

    try {
      await insertRow({
        id: 9101,
        tenant: 'rls-a',
        status: 'ACTIVE',
        score: 1,
        amount: '1.50',
        bigCount: '1',
        createdAt: '2026-01-01T00:00:00Z',
        secret: 'a-secret',
      });
      await waitForLsn(runtime); // drain the insert before subscribing so it can't arrive late as a redundant delta

      const ackA = await emitAck<any>(a, PGBASE_SUBSCRIBE, {
        model: 'LiveGatewayWidget',
        where: {},
      });
      const ackB = await emitAck<any>(b, PGBASE_SUBSCRIBE, {
        model: 'LiveGatewayWidget',
        where: {},
      });
      expect(ackA.ok).toBe(true);
      expect(ackB.ok).toBe(true);

      const snapA = wire.deserialize(ackA.snapshot) as Array<Record<string, unknown>>;
      const snapB = wire.deserialize(ackB.snapshot) as Array<Record<string, unknown>>;
      expect(snapA.map((r) => r.id)).toEqual([9101]);
      expect(snapB).toEqual([]);
      expect('secret' in snapA[0]!).toBe(false);
      expect(runtime.subscriptionCount).toBe(2);

      // Unsubscribing someone else's id is rejected; unsubscribing your own is honored.
      const badUnsub = await emitAck<any>(a, PGBASE_UNSUBSCRIBE, {
        subscriptionId: ackB.subscriptionId,
      });
      expect(badUnsub.ok).toBe(false);
      expect(runtime.subscriptionCount).toBe(2);

      const okUnsub = await emitAck<any>(a, PGBASE_UNSUBSCRIBE, {
        subscriptionId: ackA.subscriptionId,
      });
      expect(okUnsub.ok).toBe(true);
      expect(runtime.subscriptionCount).toBe(1);

      // Re-subscribe A to exercise the RLS-crossing delta below.
      const ackA2 = await emitAck<any>(a, PGBASE_SUBSCRIBE, {
        model: 'LiveGatewayWidget',
        where: {},
      });
      expect(runtime.subscriptionCount).toBe(2);

      const deltaOnA: Delta[] = [];
      const deltaOnB: Delta[] = [];
      a.on(PGBASE_DELTA, (payload: unknown) =>
        deltaOnA.push(wire.deserialize(payload as any) as Delta),
      );
      b.on(PGBASE_DELTA, (payload: unknown) =>
        deltaOnB.push(wire.deserialize(payload as any) as Delta),
      );

      // A row updated out of A's RLS scope, into B's — only B should hear about it as an upsert,
      // and A should hear a remove.
      await pool.query(`UPDATE "${TABLE}" SET tenant = 'rls-b' WHERE id = 9101`);
      await waitForLsn(runtime);

      expect(deltaOnA).toEqual([
        { kind: 'remove', subscriptionId: ackA2.subscriptionId, key: { id: 9101 } },
      ]);
      expect(deltaOnB).toHaveLength(1);
      expect(deltaOnB[0]!.kind).toBe('upsert');
      expect('secret' in ((deltaOnB[0] as any).row as object)).toBe(false);

      a.close();
      b.close();
      await waitFor(() => runtime.subscriptionCount === 0, 5_000);
    } finally {
      a.close();
      b.close();
      await pool.query(`DELETE FROM "${TABLE}" WHERE id = 9101`);
      await waitForLsn(runtime);
      await runtime.stop();
    }
  }, 30_000);

  it('wire round-trip preserves Date/BigInt/Decimal identically to an in-process read', async () => {
    const { runtime, reads, contextStore, baseUrl } = await harness();
    await runtime.start();
    await waitFor(() => runtime.stats.state === 'streaming', 15_000);

    const client = newClient(baseUrl, 'wire-tenant');
    await waitConnected(client);

    try {
      await insertRow({
        id: 9201,
        tenant: 'wire-tenant',
        status: 'ACTIVE',
        score: 1,
        amount: '1234.56',
        bigCount: '9007199254740993',
        createdAt: '2026-03-04T05:06:07.891Z',
        secret: 'x',
      });

      const direct = (await contextStore.run(
        { principal: 'wire-tenant', claims: { tenant: 'wire-tenant' } },
        () => reads.read('LiveGatewayWidget', { where: {} }),
      )) as Array<Record<string, unknown>>;

      const ack = await emitAck<any>(client, PGBASE_SUBSCRIBE, {
        model: 'LiveGatewayWidget',
        where: {},
      });
      expect(ack.ok).toBe(true);
      const snapshot = wire.deserialize(ack.snapshot) as Array<Record<string, unknown>>;

      const directRow = direct.find((r) => r.id === 9201)!;
      const wireRow = snapshot.find((r) => r.id === 9201)!;

      expect(wireRow.createdAt).toBeInstanceOf(Date);
      expect((wireRow.createdAt as Date).toISOString()).toBe(
        (directRow.createdAt as Date).toISOString(),
      );
      expect(typeof wireRow.bigCount).toBe('bigint');
      expect(wireRow.bigCount).toBe(directRow.bigCount);
      expect((wireRow.amount as FakeDecimal).toFixed()).toBe(
        (directRow.amount as FakeDecimal).toFixed(),
      );
    } finally {
      await pool.query(`DELETE FROM "${TABLE}" WHERE id = 9201`);
      await waitForLsn(runtime);
      client.close();
      await runtime.stop();
    }
  }, 30_000);

  it('refuses a subscription when this instance is not the one streaming', async () => {
    // Two instances, one slot — real leader election, the shape of any rolling deploy. The standby
    // can still run the snapshot query and return a correct-looking initial result, then never
    // deliver a delta, because WAL only reaches the slot holder. Every instance passes through
    // this state on startup while the previous holder's replication connection expires, and a
    // subscription accepted there is silently dead.
    const a = await startHttpServer();
    const b = await startHttpServer();
    const storeA = new AsyncLocalStorageContextStore();
    const storeB = new AsyncLocalStorageContextStore();
    const leader = buildRuntime(
      a.httpServer,
      new PgbaseReadService(moduleOptions, resolved, storeA),
      storeA,
    );
    const standby = buildRuntime(
      b.httpServer,
      new PgbaseReadService(moduleOptions, resolved, storeB),
      storeB,
    );

    await leader.start();
    await waitFor(() => leader.stats.state === 'streaming', 15_000);
    await standby.start();

    const socket = newClient(b.baseUrl, 'standby-tenant');
    await waitConnected(socket);
    try {
      expect(standby.stats.state).not.toBe('streaming');
      const ack = await emitAck<any>(socket, PGBASE_SUBSCRIBE, {
        model: 'LiveGatewayWidget',
        where: {},
      });
      expect(ack.ok).toBe(false);
      expect(ack.error.message).toMatch(/not streaming|slot/i);
      // A refused subscription must leave nothing behind to route to.
      expect(standby.subscriptionCount).toBe(0);
    } finally {
      socket.close();
      await standby.stop();
      await leader.stop();
      await new Promise<void>((resolve) => b.httpServer.close(() => resolve()));
      await new Promise<void>((resolve) => a.httpServer.close(() => resolve()));
    }
  }, 60_000);

  it('refuses a subscription whose result set exceeds the snapshot cap', async () => {
    // Beyond the cap the snapshot holds the first `maxRows` rows while the live predicate keeps
    // matching every row, so the client would accumulate an arbitrary subset that equals no read.
    // maxRows: 2 reproduces that with three rows instead of two hundred.
    const { httpServer, baseUrl } = await startHttpServer();
    const contextStore = new AsyncLocalStorageContextStore();
    const reads = new PgbaseReadService(moduleOptions, resolved, contextStore);
    const runtime = buildRuntime(httpServer, reads, contextStore, {
      maxRows: 2,
      statementTimeoutMs: 5_000,
    });
    await runtime.start();
    await waitFor(() => runtime.stats.state === 'streaming', 15_000);

    const socket = newClient(baseUrl, 'cap-tenant');
    await waitConnected(socket);
    try {
      for (const id of [9401, 9402, 9403]) {
        await insertRow({
          id,
          tenant: 'cap-tenant',
          status: 'ACTIVE',
          score: 1,
          amount: '1.00',
          bigCount: '1',
          createdAt: '2026-01-01T00:00:00Z',
          secret: 's',
        });
      }
      await waitForLsn(runtime);

      const ack = await emitAck<any>(socket, PGBASE_SUBSCRIBE, {
        model: 'LiveGatewayWidget',
        where: {},
      });
      expect(ack.ok).toBe(false);
      expect(ack.error.message).toMatch(/pagination|cap/i);
      // A refused subscription must leave nothing behind to route to.
      expect(runtime.subscriptionCount).toBe(0);
    } finally {
      await pool.query(`DELETE FROM "${TABLE}" WHERE id IN (9401, 9402, 9403)`);
      socket.close();
      await runtime.stop();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  }, 60_000);

  it('reconnect rebuilds the client cache from a fresh snapshot, no stale rows', async () => {
    const { runtime, baseUrl } = await harness();
    await runtime.start();
    await waitFor(() => runtime.stats.state === 'streaming', 15_000);

    await insertRow({
      id: 9301,
      tenant: 'reconnect-tenant',
      status: 'ACTIVE',
      score: 1,
      amount: '1.00',
      bigCount: '1',
      createdAt: '2026-01-01T00:00:00Z',
      secret: 'x',
    });

    const client = newClient(baseUrl, 'reconnect-tenant');
    await waitConnected(client);

    try {
      const ack1 = await emitAck<any>(client, PGBASE_SUBSCRIBE, {
        model: 'LiveGatewayWidget',
        where: { status: 'ACTIVE' },
      });
      expect(ack1.ok).toBe(true);
      expect((wire.deserialize(ack1.snapshot) as unknown[]).length).toBe(1);
      expect(runtime.subscriptionCount).toBe(1);

      // Force a disconnect. The server drops the subscription immediately — no resumption.
      client.disconnect();
      await waitFor(() => runtime.subscriptionCount === 0, 5_000);

      // Mutate while disconnected: 9301 leaves the filter, 9302 enters it. A resumed session
      // (rather than a fresh snapshot) would keep showing stale 9301 and miss 9302 entirely.
      await pool.query(`UPDATE "${TABLE}" SET status = 'INACTIVE' WHERE id = 9301`);
      await insertRow({
        id: 9302,
        tenant: 'reconnect-tenant',
        status: 'ACTIVE',
        score: 1,
        amount: '2.00',
        bigCount: '2',
        createdAt: '2026-01-02T00:00:00Z',
        secret: 'x',
      });

      client.connect();
      await waitConnected(client);
      const ack2 = await emitAck<any>(client, PGBASE_SUBSCRIBE, {
        model: 'LiveGatewayWidget',
        where: { status: 'ACTIVE' },
      });
      expect(ack2.ok).toBe(true);
      const snapshot2 = wire.deserialize(ack2.snapshot) as Array<Record<string, unknown>>;
      expect(snapshot2.map((r) => r.id)).toEqual([9302]);
    } finally {
      await pool.query(`DELETE FROM "${TABLE}" WHERE id IN (9301, 9302)`);
      await waitForLsn(runtime);
      client.close();
      await runtime.stop();
    }
  }, 30_000);
});
