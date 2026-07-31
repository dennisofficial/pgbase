import { createClient, type GetAuth } from '@dltech/pgbase/client';
import { useSyncExternalStore } from 'react';
import { io } from 'socket.io-client';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export type JobStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED';

export interface Job {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly status: JobStatus;
  readonly priority: number;
  readonly labels: readonly string[];
  readonly metadata: unknown;
  readonly closedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface Task {
  readonly id: string;
  readonly orgId: string;
  readonly jobId: string;
  readonly title: string;
  readonly done: boolean;
  readonly blockedBy: unknown;
  readonly createdAt: Date;
}

/** `actorId` is absent, not blank — the policy omits it server-side, so it never reaches the wire. */
export interface AuditLog {
  readonly id: bigint;
  readonly action: string;
  readonly at: Date;
}

export interface Invoice {
  readonly id: string;
  readonly orgId: string;
  /** Decimal(18,4). Arrives as a string: 18 digits of precision do not survive a JS number. */
  readonly amount: string;
  readonly externalRef: bigint;
  readonly issuedAt: Date;
}

export interface Org {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

interface Models {
  readonly Job: Job;
  readonly Task: Task;
  readonly AuditLog: AuditLog;
  readonly Invoice: Invoice;
  readonly Org: Org;
}

// ─────────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────────
// Stands in for a login. Alice and Bob share an org, so two windows signed in as the two of them
// are a real collaborative session; Carol is in a different org and proves the isolation.

export const DEV_USERS = {
  alice: {
    id: '00000000-0000-4000-8000-0000000000a1',
    name: 'Alice Chen',
    org: 'Northwind Robotics',
  },
  bob: { id: '00000000-0000-4000-8000-0000000000a2', name: 'Bob Osei', org: 'Northwind Robotics' },
  carol: { id: '00000000-0000-4000-8000-0000000000b1', name: 'Carol Vega', org: 'Acme Freight' },
} as const;

export type DevUser = keyof typeof DEV_USERS;

const SESSION_KEY = 'pgbase-example-user';

let currentUser: DevUser = 'alice';
const userListeners = new Set<() => void>();

export function getCurrentUser(): DevUser {
  return currentUser;
}

export function getAuthHeaders(): Record<string, string> {
  return { 'x-pgbase-dev-user': DEV_USERS[currentUser].id };
}

const getAuth: GetAuth = () => getAuthHeaders();

// Creating the client opens nothing; the socket connects lazily on the first live query.
export const pgbase = createClient<Models>({
  baseUrl: API_URL,
  getAuth,
  createSocket: (baseUrl, opts) => io(baseUrl, opts),
});

export function setCurrentUser(next: DevUser): void {
  if (next === currentUser) return;
  currentUser = next;
  window.sessionStorage.setItem(SESSION_KEY, next);
  // Same getter, but re-setting it reconnects the socket, so every open subscription resyncs under
  // the new claims instead of keeping rows the previous identity was allowed to see.
  pgbase.$setAuth(getAuth);
  for (const listener of userListeners) listener();
}

/** Per-tab, so two windows can hold two identities across reloads. Called once, after mount. */
export function restoreCurrentUser(): void {
  const stored = window.sessionStorage.getItem(SESSION_KEY);
  if (stored !== null && stored in DEV_USERS) setCurrentUser(stored as DevUser);
}

export function useCurrentUser(): DevUser {
  return useSyncExternalStore(
    (listener) => {
      userListeners.add(listener);
      return () => userListeners.delete(listener);
    },
    getCurrentUser,
    () => 'alice' as DevUser,
  );
}
