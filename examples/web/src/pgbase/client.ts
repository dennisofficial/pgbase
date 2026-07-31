import { createClient, type LiveSocket } from '@workspace/pgbase/client';
import { io } from 'socket.io-client';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export const DEV_USERS = {
  alice: '00000000-0000-4000-8000-0000000000a1',
  carol: '00000000-0000-4000-8000-0000000000b1',
} as const;

// Matches ORG_A / ORG_B in examples/api/prisma/seed.ts — alice is the only member of org A,
// carol the only member of org B.
export const DEV_ORGS = {
  alice: '00000000-0000-4000-8000-00000000000a',
  carol: '00000000-0000-4000-8000-00000000000b',
} as const;

export type DevUser = keyof typeof DEV_USERS;

export interface Job {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly priority: number;
  readonly orgId: string;
}

// The one model in the schema with an omit list covering every column but its primary key (see
// pgbasePolicies.AuditLog in the API) — `id` is the only field that ever arrives. Its Postgres
// type is int8, which superjson decodes to a real JS `bigint`, not a number or string.
export interface AuditLog {
  readonly id: bigint;
}

interface Models {
  readonly Job: Job;
  readonly AuditLog: AuditLog;
}

// Captured so the reconnect-scenario page can drive real disconnect/reconnect cycles at will,
// instead of racing `$setAuth`'s own disconnect+reconnect. Nothing else in this app should reach
// for this — every other page talks to `pgbase` only.
let liveSocket: LiveSocket | null = null;

// One instance for the whole app, imported wherever it's needed — creating it doesn't open a
// socket; the client connects lazily on the first live query or read.
export const pgbase = createClient<Models>({
  baseUrl: API_URL,
  getAuth: () => ({ 'x-pgbase-dev-user': DEV_USERS.alice }),
  createSocket: (baseUrl, opts) => {
    const socket = io(baseUrl, opts);
    liveSocket = socket as unknown as LiveSocket;
    return liveSocket;
  },
});

// A real app reads the caller off a session, not a dropdown — this is dev-only stand-in for a
// login that changes identity. `$setAuth` reconnects the socket under the new claims rather than
// the caller having to throw away and rebuild the client to switch users.
export function setDevUser(user: DevUser): void {
  pgbase.$setAuth({ 'x-pgbase-dev-user': DEV_USERS[user] });
}

/** Manual, held-open disconnect — unlike `$setAuth`, this does not immediately reconnect. Demo-only. */
export function forceDisconnect(): void {
  (liveSocket as unknown as { disconnect(): void } | null)?.disconnect();
}

export function forceReconnect(): void {
  (liveSocket as unknown as { connect(): void } | null)?.connect();
}
