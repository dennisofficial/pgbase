import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createWireCodec } from '@workspace/pgbase/read';
import 'reflect-metadata';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';

const ALICE = '00000000-0000-4000-8000-0000000000a1';
const CAROL = '00000000-0000-4000-8000-0000000000b1';

const wire = createWireCodec();

let app: INestApplication;
let url: string;

async function waitFor<T>(
  produce: () => T | undefined,
  what: string,
  timeoutMs = 20_000,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = produce();
    if (value !== undefined) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

interface Connected {
  readonly socket: Socket;
  readonly deltas: unknown[];
}

async function connect(user: string): Promise<Connected> {
  const socket = io(url, { transports: ['websocket'], auth: { 'x-pgbase-dev-user': user } });
  const deltas: unknown[] = [];
  socket.on('pgbase:delta', (raw: unknown) => deltas.push(raw));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  return { socket, deltas };
}

function subscribe(socket: Socket, model: string, where?: unknown): Promise<any> {
  return new Promise((resolve) =>
    socket.emit('pgbase:subscribe', { model, where }, (ack: unknown) => resolve(ack)),
  );
}

function bump(id: string, user: string): Promise<Response> {
  return fetch(`${url}/jobs/${id}/bump-priority`, {
    method: 'POST',
    headers: { 'x-pgbase-dev-user': user },
  });
}

beforeAll(async () => {
  try {
    process.loadEnvFile();
  } catch {}
  // A slot of its own, so this never fights a running dev server for the app's slot and silently
  // falls back to standby — which is indistinguishable from "no deltas ever arrive".
  process.env.PGBASE_SLOT ??= 'pgbase_e2e';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  // The same configuration main.ts applies, so this suite exercises the real one.
  configureApp(app);
  // A real listening server: socket.io attaches to it, so `app.init()` alone is not enough.
  await app.listen(0);
  url = (await app.getUrl()).replace('[::1]', 'localhost');
}, 90_000);

afterAll(async () => {
  await app?.close();
});

describe('live subscriptions, end to end through Nest', () => {
  it('delivers a write to a subscriber over the WAL, with nobody publishing anything', async () => {
    const { socket, deltas } = await connect(ALICE);
    try {
      const ack = await subscribe(socket, 'Job');
      expect(ack.ok, ack.error?.message).toBe(true);

      const snapshot = wire.deserialize(ack.snapshot) as { id: string; priority: number }[];
      expect(snapshot.length).toBeGreaterThan(0);

      const target = snapshot[0]!;
      const res = await bump(target.id, ALICE);
      expect(res.ok).toBe(true);

      const raw = await waitFor(() => deltas[0], 'a delta over the WAL');
      const delta = wire.deserialize(raw) as { kind: string; row: Record<string, unknown> };
      expect(delta.kind).toBe('upsert');
      expect(delta.row.priority).toBe(target.priority + 1);
    } finally {
      socket.close();
    }
  });

  it("never leaks another org's rows or write activity to a subscriber", async () => {
    const alice = await connect(ALICE);
    const carol = await connect(CAROL);
    try {
      const aliceAck = await subscribe(alice.socket, 'Job');
      const carolAck = await subscribe(carol.socket, 'Job');
      const aliceJobs = wire.deserialize(aliceAck.snapshot) as { id: string }[];
      const carolJobs = wire.deserialize(carolAck.snapshot) as { id: string }[];

      expect(aliceJobs.filter((j) => carolJobs.some((c) => c.id === j.id))).toEqual([]);
      expect(carolJobs.length).toBeGreaterThan(0);

      const before = alice.deltas.length;
      await bump(carolJobs[0]!.id, CAROL);
      await waitFor(() => (carol.deltas.length > 0 ? true : undefined), "carol's own delta");
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Not just "alice's cache is still right" — she must receive nothing at all. A `remove`
      // naming the primary key would disclose that the row exists and was written to.
      expect(alice.deltas.length).toBe(before);
    } finally {
      alice.socket.close();
      carol.socket.close();
    }
  });

  it('accepts the header auth path too, which is what server-side callers use', async () => {
    const socket = io(url, {
      transports: ['websocket'],
      extraHeaders: { 'x-pgbase-dev-user': ALICE },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', reject);
      });
      expect(socket.connected).toBe(true);
    } finally {
      socket.close();
    }
  });

  it('rejects a connection with no principal rather than serving an empty result', async () => {
    const socket = io(url, { transports: ['websocket'] });
    try {
      const err = await new Promise<Error>((resolve, reject) => {
        socket.once('connect_error', resolve);
        socket.once('connect', () => reject(new Error('connected without a principal')));
      });
      expect(err.message).toMatch(/x-pgbase-dev-user/i);
    } finally {
      socket.close();
    }
  });

  it('lets a CORS preflight through without authenticating it', async () => {
    // A preflight carries no credentials by design. A 401 here reaches the browser as an opaque
    // CORS error, so every cross-origin write fails with nothing explaining why.
    const res = await fetch(`${url}/jobs/00000000-0000-4000-8000-0000000a0001/bump-priority`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-pgbase-dev-user',
      },
    });
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
  });
});
