'use client';

import { useRef, useState } from 'react';
import { EventLog, useEventLog } from '../../../components/event-log';
import { ScenarioShell, runButtonStyle } from '../../../components/scenario-shell';
import { API_URL, DEV_ORGS, DEV_USERS, pgbase, type Job } from '../../../pgbase/client';

const USER = 'alice' as const;

export default function WatchDeletePage() {
  const [row, setRow] = useState<Job | null>(null);
  const [running, setRunning] = useState(false);
  const { events, log, clear } = useEventLog();
  const unsubscribeRef = useRef<(() => void) | null>(null);

  async function run() {
    if (running) return;
    setRunning(true);
    clear();
    setRow(null);
    unsubscribeRef.current?.();

    const res = await fetch(`${API_URL}/simulations/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pgbase-dev-user': DEV_USERS[USER] },
      body: JSON.stringify({ orgId: DEV_ORGS[USER], name: `watch-delete demo ${Date.now()}` }),
    });
    const created: Job = await res.json();
    log(`server: created job ${created.id} ("${created.name}")`);

    await new Promise<void>((resolve) => {
      let sawSnapshot = false;
      unsubscribeRef.current = pgbase.Job.subscribeOne({
        where: { id: created.id },
        onUpdate: (next) => {
          setRow(next);
          if (next && !sawSnapshot) {
            sawSnapshot = true;
            log('live: subscribeOne snapshot arrived — row is visible');
            resolve();
          } else if (!next && sawSnapshot) {
            log('live: delta received — subscribeOne now reports null');
          }
        },
        onError: (err) => log(`error: ${err.message}`),
      });
    });

    await fetch(`${API_URL}/simulations/jobs/${created.id}`, {
      method: 'DELETE',
      headers: { 'x-pgbase-dev-user': DEV_USERS[USER] },
    });
    log('server: delete requested');
    setRunning(false);
  }

  return (
    <ScenarioShell
      title="Watching one row that gets deleted"
      blurb={
        <>
          Subscribes to a single job with <code>subscribeOne</code>, then deletes that row
          server-side. There is no explicit &quot;deleted&quot; event — the client just sees its
          snapshot become <code>null</code>.
        </>
      }
    >
      <button onClick={() => void run()} disabled={running} style={runButtonStyle(running)}>
        Run simulation
      </button>

      <p style={{ marginTop: '1rem' }}>
        <strong>subscribeOne snapshot:</strong>{' '}
        {row ? (
          <>
            {row.name} — {row.status} (priority {row.priority})
          </>
        ) : (
          <em>null</em>
        )}
      </p>

      <EventLog events={events} />
    </ScenarioShell>
  );
}
