'use client';

import { useLiveQuery } from '@workspace/pgbase/react';
import { useEffect, useRef, useState } from 'react';
import { EventLog, useEventLog } from '../../../components/event-log';
import { ScenarioShell } from '../../../components/scenario-shell';
import { API_URL, DEV_ORGS, DEV_USERS, pgbase, setDevUser, type DevUser, type Job } from '../../../pgbase/client';

const ORG_LABEL: Record<DevUser, string> = { alice: 'Org A', carol: 'Org B' };

export default function RlsIsolationPage() {
  const [viewer, setViewer] = useState<DevUser>('alice');
  const rows = useLiveQuery(pgbase.Job);
  const { events, log, clear } = useEventLog();

  const rowsRef = useRef<readonly Job[]>(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  // pgbase's client is one connection for the whole app — it can only be authenticated as one
  // identity at a time. These two panes are not two live sockets side by side: only the one
  // matching `viewer` is live right now. The other freezes at whatever it last showed, which is
  // itself the point — switching identity throws away and rebuilds the view, it does not merge.
  const [captured, setCaptured] = useState<Record<DevUser, readonly Job[]>>({ alice: [], carol: [] });
  useEffect(() => {
    setCaptured((prev) => ({ ...prev, [viewer]: rows }));
  }, [rows, viewer]);

  function switchViewer(next: DevUser) {
    setViewer(next);
    setDevUser(next);
    log(`client: $setAuth → viewing as ${next} (${ORG_LABEL[next]})`);
  }

  async function simulateWrite(as: DevUser) {
    const orgId = DEV_ORGS[as];
    const res = await fetch(`${API_URL}/simulations/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pgbase-dev-user': DEV_USERS[as] },
      body: JSON.stringify({ orgId, name: `rls-isolation demo ${Date.now()}` }),
    });
    const created: Job = await res.json();
    log(`server: ${as} created job ${created.id} in ${ORG_LABEL[as]}`);

    setTimeout(() => {
      const visible = rowsRef.current.some((r) => r.id === created.id);
      log(
        `check: viewing as ${viewer} (${ORG_LABEL[viewer]}) — the ${ORG_LABEL[as]} row is ` +
          `${visible ? 'VISIBLE (would be a leak)' : 'not visible — isolated'}`,
      );
      void fetch(`${API_URL}/simulations/jobs/${created.id}`, {
        method: 'DELETE',
        headers: { 'x-pgbase-dev-user': DEV_USERS[as] },
      });
    }, 800);
  }

  return (
    <ScenarioShell
      title="RLS isolation across identities"
      blurb={
        <>
          Switch the live connection between alice (Org A) and carol (Org B) with{' '}
          <code>$setAuth</code>, then simulate a write in either org. A write to one org must
          never reach a live view scoped to the other.
        </>
      }
    >
      <p>
        Live pane is currently:{' '}
        <select value={viewer} onChange={(e) => switchViewer(e.target.value as DevUser)}>
          <option value="alice">alice (Org A)</option>
          <option value="carol">carol (Org B)</option>
        </select>
      </p>

      <p>
        <button onClick={() => void simulateWrite('alice')}>Simulate: alice writes to Org A</button>{' '}
        <button onClick={() => void simulateWrite('carol')}>Simulate: carol writes to Org B</button>
      </p>

      <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
        {(['alice', 'carol'] as const).map((who) => (
          <div key={who} style={{ flex: 1, border: '1px solid #ddd', borderRadius: 6, padding: '0.7rem' }}>
            <strong>
              {who} ({ORG_LABEL[who]}) {who === viewer ? '— LIVE' : '— captured, not live'}
            </strong>
            <ul style={{ paddingLeft: '1.1rem', margin: '0.4rem 0 0' }}>
              {captured[who].length === 0 && <li style={{ color: '#999' }}>no jobs visible</li>}
              {captured[who].map((job) => (
                <li key={job.id}>
                  {job.name} — {job.status}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <EventLog events={events} />
      <p style={{ marginTop: '0.5rem' }}>
        <button onClick={clear}>Clear log</button>
      </p>
    </ScenarioShell>
  );
}
