'use client';

import { useLiveQuery } from '@workspace/pgbase/react';
import { useEffect, useState } from 'react';
import { API_URL, DEV_USERS, createClient, type Connection, type DevUser } from '../pgbase/client';

interface Job {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly priority: number;
  readonly orgId: string;
}

export default function Page() {
  const [user, setUser] = useState<DevUser>('alice');
  const [error, setError] = useState<string | null>(null);
  const [conn, setConn] = useState<Connection | null>(null);

  useEffect(() => {
    const next = createClient(user);
    setConn(next);
    setError(null);

    const onError = (err: Error) => setError(err.message);
    const onConnect = () => setError(null);
    next.socket.on('connect_error', onError);
    next.socket.on('connect', onConnect);

    return () => {
      next.socket.off('connect_error', onError);
      next.socket.off('connect', onConnect);
      next.client.dispose();
      next.socket.close();
      setConn((current) => (current === next ? null : current));
    };
  }, [user]);

  const jobs = useLiveQuery<Job>(conn?.client, 'Job');

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
        Viewing as{' '}
        <select value={user} onChange={(e) => setUser(e.target.value as DevUser)}>
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

      {error !== null && (
        <p style={{ color: '#b00', marginTop: '1rem' }}>
          <strong>Not connected:</strong> {error}
        </p>
      )}
      {error === null && jobs.length === 0 && <p>No jobs visible to this user.</p>}

      <p style={{ marginTop: '2rem', color: '#666', fontSize: '0.9rem' }}>
        Open this page in two windows. A bump in one appears in the other without either asking the
        server for it — and a change to org B&apos;s jobs never reaches a window viewing as alice.
      </p>
    </main>
  );
}
