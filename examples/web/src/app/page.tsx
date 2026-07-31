'use client';

import { useLiveQuery } from '@dltech/pgbase/react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { API_URL, DEV_USERS, pgbase, setDevUser, type DevUser } from '../pgbase/client';

export default function Page() {
  const [user, setUser] = useState<DevUser>('alice');
  const [connectionError, setConnectionError] = useState<string | null>(null);

  useEffect(
    () =>
      pgbase.$onStatusChange((status) =>
        setConnectionError(status.state === 'error' ? (status.error?.message ?? 'Connection failed') : null),
      ),
    [],
  );

  function changeUser(next: DevUser) {
    setUser(next);
    setDevUser(next);
  }

  const jobs = useLiveQuery(pgbase.Job);

  async function bump(id: string) {
    await fetch(`${API_URL}/jobs/${id}/bump-priority`, {
      method: 'POST',
      headers: { 'x-pgbase-dev-user': DEV_USERS[user] },
    });
  }

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: '46rem' }}>
      <h1>pgbase live example</h1>

      <p>
        <Link href="/scenarios">Scenario demos →</Link> — deletion, filter boundaries, RLS
        isolation, reconnect, and column omission, each with a one-click simulation and an event
        log.
      </p>

      <p>
        Viewing as{' '}
        <select value={user} onChange={(e) => changeUser(e.target.value as DevUser)}>
          <option value="alice">alice (org A)</option>
          <option value="carol">carol (org B)</option>
        </select>{' '}
        — each user sees only their own org&apos;s jobs, enforced server-side.
      </p>

      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>
            <th>Job</th>
            <th>Status</th>
            <th style={{ textAlign: 'right' }}>Priority</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id} style={{ borderBottom: '1px solid #eee' }}>
              <td>{job.name}</td>
              <td>{job.status}</td>
              <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {job.priority}
              </td>
              <td style={{ textAlign: 'right' }}>
                <button onClick={() => void bump(job.id)}>Bump priority</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {connectionError !== null && (
        <p style={{ color: '#b00', marginTop: '1rem' }}>
          <strong>Not connected:</strong> {connectionError}
        </p>
      )}
      {connectionError === null && jobs.length === 0 && <p>No jobs visible to this user.</p>}

      <p style={{ marginTop: '2rem', color: '#666', fontSize: '0.9rem' }}>
        Open this page in two windows. A bump in one appears in the other without either asking the
        server for it — and a change to org B&apos;s jobs never reaches a window viewing as alice.
      </p>
    </main>
  );
}
