'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  DEV_USERS,
  pgbase,
  restoreCurrentUser,
  setCurrentUser,
  useCurrentUser,
  type DevUser,
} from '../pgbase/client';

export function AppHeader() {
  const user = useCurrentUser();

  useEffect(restoreCurrentUser, []);

  return (
    <header className="app">
      <span className="brand">Opsboard</span>
      <nav>
        <Link href="/">Board</Link>
        <Link href="/activity">Activity</Link>
        <Link href="/billing">Billing</Link>
      </nav>
      <label>
        Signed in as{' '}
        <select value={user} onChange={(e) => setCurrentUser(e.target.value as DevUser)}>
          {Object.entries(DEV_USERS).map(([key, u]) => (
            <option key={key} value={key}>
              {u.name} — {u.org}
            </option>
          ))}
        </select>
      </label>
      <ConnectionPill />
    </header>
  );
}

const PILL_COLOR: Record<string, string> = {
  connected: '#1a7f37',
  connecting: '#9a6700',
  disconnected: '#9a6700',
  error: '#b3261e',
  idle: '#6b6b75',
};

function ConnectionPill() {
  const [state, setState] = useState('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () =>
      pgbase.$onStatusChange((status) => {
        setState(status.state);
        setError(status.error?.message ?? null);
      }),
    [],
  );

  return (
    <span className="pill" style={{ color: PILL_COLOR[state] }} title={error ?? undefined}>
      <span className="dot" />
      {error !== null ? `${state}: ${error}` : state}
    </span>
  );
}
