'use client';

import { useLiveQuery } from '@dltech/pgbase/react';
import { useEffect, useRef, useState } from 'react';
import { EventLog, useEventLog } from '../../../components/event-log';
import { ScenarioShell, runButtonStyle } from '../../../components/scenario-shell';
import { API_URL, DEV_ORGS, DEV_USERS, pgbase, type Job } from '../../../pgbase/client';

const USER = 'alice' as const;

export default function FilterBoundaryPage() {
  const rows = useLiveQuery(pgbase.Job, { where: { status: 'RUNNING' } });
  const [running, setRunning] = useState(false);
  const [watchedId, setWatchedId] = useState<string | null>(null);
  const { events, log, clear } = useEventLog();

  const waiterRef = useRef<{ predicate: (rows: readonly Job[]) => boolean; resolve: () => void } | null>(
    null,
  );

  useEffect(() => {
    if (waiterRef.current && waiterRef.current.predicate(rows)) {
      waiterRef.current.resolve();
      waiterRef.current = null;
    }
  }, [rows]);

  function waitFor(predicate: (rows: readonly Job[]) => boolean): Promise<void> {
    return new Promise((resolve) => {
      waiterRef.current = { predicate, resolve };
    });
  }

  async function jobPatch(id: string, status: string) {
    await fetch(`${API_URL}/simulations/jobs/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-pgbase-dev-user': DEV_USERS[USER] },
      body: JSON.stringify({ status }),
    });
  }

  async function run() {
    if (running) return;
    setRunning(true);
    clear();

    const res = await fetch(`${API_URL}/simulations/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pgbase-dev-user': DEV_USERS[USER] },
      body: JSON.stringify({ orgId: DEV_ORGS[USER], name: `filter-boundary demo ${Date.now()}`, status: 'QUEUED' }),
    });
    const created: Job = await res.json();
    setWatchedId(created.id);
    log(`server: created ${created.id} as QUEUED — outside the { status: "RUNNING" } filter`);

    await jobPatch(created.id, 'RUNNING');
    log('server: flipped it to RUNNING');
    await waitFor((current) => current.some((r) => r.id === created.id));
    log('live: row entered the subscribed list (upsert)');

    await jobPatch(created.id, 'DONE');
    log('server: flipped it to DONE');
    await waitFor((current) => !current.some((r) => r.id === created.id));
    log('live: row left the subscribed list (remove)');

    await fetch(`${API_URL}/simulations/jobs/${created.id}`, {
      method: 'DELETE',
      headers: { 'x-pgbase-dev-user': DEV_USERS[USER] },
    });
    log('server: cleaned up the demo row');
    setWatchedId(null);
    setRunning(false);
  }

  return (
    <ScenarioShell
      title="A row entering and leaving a filter"
      blurb={
        <>
          A live query subscribed to <code>{'{ status: "RUNNING" }'}</code>. The simulation creates
          a job outside the filter, flips it in (upsert), then flips it back out (remove).
        </>
      }
    >
      <button onClick={() => void run()} disabled={running} style={runButtonStyle(running)}>
        Run simulation
      </button>

      <table style={{ borderCollapse: 'collapse', width: '100%', marginTop: '1rem' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>
            <th>Job</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((job) => (
            <tr
              key={job.id}
              style={{
                borderBottom: '1px solid #eee',
                background: job.id === watchedId ? '#fffbdd' : undefined,
              }}
            >
              <td>{job.name}</td>
              <td>{job.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p style={{ color: '#666' }}>No RUNNING jobs right now.</p>}

      <EventLog events={events} />
    </ScenarioShell>
  );
}
