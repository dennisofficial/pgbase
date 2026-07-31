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
import { PGBASE_DELTA, PGBASE_SUBSCRIBE } from '../../live/protocol.js';
import type { Delta } from '../../live/types.js';
import { definePolicy } from '../../policy/define.js';
import { validatePolicies } from '../../policy/index.js';
import { PgbaseWireCodec } from '../../read/index.js';
import { createTestPool } from '../../schema/test-support.js';
import type { ResolvedModel } from '../../schema/types.js';
import { PostgresChangeTransport } from '../../transport/postgres.js';
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
import { createFakePrisma } from './fake-prisma.js';

const TABLE = 'pgbase_live_fanout_widgets';
const PUBLICATION = 'pgbase_live_fanout_widgets_pub';
const SLOT = 'pgbase_live_fanout_widgets_slot';
const DEV_HEADER = 'x-pgbase-dev-user';

interface Claims {
  readonly tenant: string;
}

interface Row {
  readonly id: number;
  readonly tenant: string;
  readonly status: string;
}

const widgetPolicy = definePolicy<Row, Claims>('FanoutWidget')({
  omit: [],
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
let model: ResolvedModel;
let resolved: Resolved;
let moduleOptions: PgbaseModuleOptions<string, Claims>;
const wire = new PgbaseWireCodec();

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

async function insertRow(row: { id: number; tenant: string; status: string }): Promise<void> {
  await pool.query(`INSERT INTO "${TABLE}" VALUES ($1,$2,$3)`, [row.id, row.tenant, row.status]);
}

function buildRuntime(
  httpServer: NodeHttpServer,
  transport?: PostgresChangeTransport,
): PgbaseLiveRuntime {
  const contextStore = new AsyncLocalStorageContextStore();
  const reads = new PgbaseReadService(moduleOptions, resolved, contextStore);
  const opts: PgbaseLiveRuntimeOptions = {
    httpServer,
    pool,
    schema: resolved.schema,
    policies: resolved.policies,
    reads,
    contextStore,
    claims: new MemoryClaimsCache({ ...moduleOptions, claimsBuilder: new StaticClaimsBuilder() }),
    wire,
    getPrincipal,
    wal: {
      replicationConfig: WAL_REPLICATION_CONFIG,
      slotName: SLOT,
      publication: PUBLICATION,
      acquireRetryMs: 100,
      statusIntervalMs: 500,
    },
    ...(transport ? { transport } : {}),
  };
  return new PgbaseLiveRuntime(opts);
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
      status text NOT NULL
    )
  `);
  model = await resolveSimpleModel(pool, 'FanoutWidget', TABLE, [
    { name: 'id', required: true },
    { name: 'tenant', required: true },
    { name: 'status', required: true },
  ]);
  resolved = {
    schema: schemaOf(model, PUBLICATION),
    policies: validatePolicies(schemaOf(model, PUBLICATION), { FanoutWidget: widgetPolicy }),
  };
  moduleOptions = {
    pool,
    prisma: createFakePrisma(pool, model),
    schema: { formatVersion: SCHEMA_FORMAT_VERSION, models: [], enums: [] },
    policies: { FanoutWidget: widgetPolicy },
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
    const { rows } = await pool.query('SELECT slot_name FROM pg_replication_slots');
    expect(rows).toEqual([]);
    await pool.end();
  }
});

describe('PgbaseLiveRuntime fanout', () => {
  it('a shared transport lets the standby serve a delta for a write only the leader observed, with no double-delivery on the leader', async () => {
    const a = await startHttpServer();
    const b = await startHttpServer();
    const channel = 'pgbase_fanout_shared';
    const transportA = new PostgresChangeTransport({ pool, channel });
    const transportB = new PostgresChangeTransport({ pool, channel });
    const leader = buildRuntime(a.httpServer, transportA);
    const standby = buildRuntime(b.httpServer, transportB);

    await leader.start();
    await waitFor(() => leader.stats.state === 'streaming', 15_000);
    await standby.start();
    expect(standby.stats.state).not.toBe('streaming');

    const leaderSocket = newClient(a.baseUrl, 'fanout-tenant');
    const standbySocket = newClient(b.baseUrl, 'fanout-tenant');
    await Promise.all([waitConnected(leaderSocket), waitConnected(standbySocket)]);

    try {
      const ackLeader = await emitAck<any>(leaderSocket, PGBASE_SUBSCRIBE, {
        model: 'FanoutWidget',
        where: {},
      });
      const ackStandby = await emitAck<any>(standbySocket, PGBASE_SUBSCRIBE, {
        model: 'FanoutWidget',
        where: {},
      });
      // The standby is not streaming, yet it is acked — a transport is configured, so the
      // "this instance can't deliver live changes" refusal does not apply.
      expect(ackLeader.ok).toBe(true);
      expect(ackStandby.ok).toBe(true);

      const leaderDeltas: Delta[] = [];
      const standbyDeltas: Delta[] = [];
      leaderSocket.on(PGBASE_DELTA, (payload: unknown) =>
        leaderDeltas.push(wire.deserialize(payload as any) as Delta),
      );
      standbySocket.on(PGBASE_DELTA, (payload: unknown) =>
        standbyDeltas.push(wire.deserialize(payload as any) as Delta),
      );

      await insertRow({ id: 1, tenant: 'fanout-tenant', status: 'ACTIVE' });

      // The whole point: the standby never touched WAL for this write, only the transport did.
      await waitFor(() => standbyDeltas.length > 0, 10_000);
      expect(standbyDeltas).toHaveLength(1);
      expect(standbyDeltas[0]!.kind).toBe('upsert');

      await waitFor(() => leaderDeltas.length > 0, 5_000);
      // Give a would-be duplicate (leader routing both locally and via its own transport
      // subscription) a real chance to arrive before asserting there is exactly one.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(leaderDeltas).toHaveLength(1);
    } finally {
      leaderSocket.close();
      standbySocket.close();
      await pool.query(`DELETE FROM "${TABLE}" WHERE id = 1`);
      await waitForLsn(leader);
      await standby.stop();
      await leader.stop();
      await new Promise<void>((resolve) => b.httpServer.close(() => resolve()));
      await new Promise<void>((resolve) => a.httpServer.close(() => resolve()));
    }
  }, 60_000);

  it('is not vacuous: mismatched transport channels deliver nothing to the standby, even though the leader observed the write and the subscription was accepted', async () => {
    const a = await startHttpServer();
    const b = await startHttpServer();
    const transportA = new PostgresChangeTransport({ pool, channel: 'pgbase_fanout_leader_only' });
    const transportB = new PostgresChangeTransport({
      pool,
      channel: 'pgbase_fanout_standby_only',
    });
    const leader = buildRuntime(a.httpServer, transportA);
    const standby = buildRuntime(b.httpServer, transportB);

    await leader.start();
    await waitFor(() => leader.stats.state === 'streaming', 15_000);
    await standby.start();

    const standbySocket = newClient(b.baseUrl, 'fanout-broken-tenant');
    await waitConnected(standbySocket);
    try {
      const ack = await emitAck<any>(standbySocket, PGBASE_SUBSCRIBE, {
        model: 'FanoutWidget',
        where: {},
      });
      expect(ack.ok).toBe(true);

      const deltas: Delta[] = [];
      standbySocket.on(PGBASE_DELTA, (payload: unknown) =>
        deltas.push(wire.deserialize(payload as any) as Delta),
      );

      await insertRow({ id: 2, tenant: 'fanout-broken-tenant', status: 'ACTIVE' });
      await waitForLsn(leader); // proves the leader itself did observe and emit the change

      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(deltas).toHaveLength(0);
    } finally {
      standbySocket.close();
      await pool.query(`DELETE FROM "${TABLE}" WHERE id = 2`);
      await waitForLsn(leader);
      await standby.stop();
      await leader.stop();
      await new Promise<void>((resolve) => b.httpServer.close(() => resolve()));
      await new Promise<void>((resolve) => a.httpServer.close(() => resolve()));
    }
  }, 60_000);
});
