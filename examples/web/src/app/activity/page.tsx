'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { useActivityQuery } from '../../redux/live-api';

export default function ActivityPage() {
  const { data = [], error } = useActivityQuery();

  // `id` is an int8 sequence, so it decodes to a real bigint and sorts the rows by write order.
  const ordered = useMemo(() => [...data].sort((a, b) => (a.id < b.id ? 1 : -1)), [data]);

  return (
    <main>
      <h1>Your activity</h1>
      <p className="lede">
        Written by the API as a side effect of every mutation, and delivered here over the same WAL
        stream as everything else. Two things are worth noticing: this list is yours alone —{' '}
        <code>audit_log</code> has no org column, so the policy scopes it to the caller — and{' '}
        <code>actorId</code> is <em>absent</em> from every row below rather than blank, because the
        policy omits it server-side.
      </p>

      {error !== undefined && <div className="error">{String(error)}</div>}

      <table>
        <thead>
          <tr>
            <th style={{ width: '6rem' }}>id</th>
            <th style={{ width: '11rem' }}>at</th>
            <th>action</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((entry) => (
            <tr key={String(entry.id)}>
              <td className="num">{String(entry.id)}</td>
              <td>{entry.at.toLocaleTimeString()}</td>
              <td>{entry.action}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {ordered.length === 0 && (
        <p className="empty">Nothing yet — move a job on the board and it shows up here.</p>
      )}

      <p className="lede" style={{ marginTop: '1.2rem' }}>
        This page reads through RTK Query rather than the React hook the <Link href="/">board</Link>{' '}
        uses. Same subscription underneath, cached in the Redux store.
      </p>
    </main>
  );
}
