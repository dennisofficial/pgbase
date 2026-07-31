'use client';

import { useLiveQuery } from '@dltech/pgbase/react';
import type { ConnectionStatus } from '@dltech/pgbase/client';
import { useEffect, useRef, useState } from 'react';
import { EventLog, useEventLog } from '../../../components/event-log';
import { ScenarioShell, runButtonStyle } from '../../../components/scenario-shell';
import {
  API_URL,
  DEV_ORGS,
  DEV_USERS,
  forceDisconnect,
  forceReconnect,
  pgbase,
  type Job,
} from '../../../pgbase/client';

const USER = 'alice' as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function ReconnectPage() {
  const rows = useLiveQuery(pgbase.Job, { where: { orgId: DEV_ORGS[USER] } });
  const rowsRef = useRef<readonly Job[]>(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  const [status, setStatus] = useState<ConnectionStatus>(pgbase.$status());
  const [running, setRunning] = useState(false);
  const { events, log, clear } = useEventLog();

  useEffect(() => pgbase.$onStatusChange((s) => setStatus(s)), []);

  async function run() {
    if (running) return;
    setRunning(true);
    clear();

    const res = await fetch(`${API_URL}/simulations/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pgbase-dev-user': DEV_USERS[USER] },
      body: JSON.stringify({ orgId: DEV_ORGS[USER], name: `reconnect demo ${Date.now()}`, status: 'QUEUED' }),
    });
    const created: Job = await res.json();
    log(`server: created ${created.id} — priority 0, QUEUED`);

    await new Promise<void>((resolve) => {
      const check = () => {
        if (rowsRef.current.some((r) => r.id === created.id)) resolve();
        else setTimeout(check, 30);
      };
      check();
    });
    log('live: row visible in the connected cache');

    forceDisconnect();
    log('client: forced disconnect (socket.disconnect(), no auto-reconnect)');
    await sleep(200);

    await fetch(`${API_URL}/simulations/jobs/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-pgbase-dev-user': DEV_USERS[USER] },
      body: JSON.stringify({ status: 'RUNNING' }),
    });
    log('server: flipped it to RUNNING — while the client is disconnected, this cannot arrive');
    await sleep(1200);
    const stillQueued = rowsRef.current.find((r) => r.id === created.id)?.status === 'QUEUED';
    log(`client: cache still shows ${stillQueued ? 'QUEUED (unchanged, as expected)' : 'something else'}`);

    forceReconnect();
    log('client: reconnect requested');

    await new Promise<void>((resolve) => {
      const check = () => {
        if (rowsRef.current.find((r) => r.id === created.id)?.status === 'RUNNING') resolve();
        else setTimeout(check, 30);
      };
      check();
    });
    log('live: cache resynced from a fresh snapshot — now shows RUNNING, made while offline');

    await fetch(`${API_URL}/simulations/jobs/${created.id}`, {
      method: 'DELETE',
      headers: { 'x-pgbase-dev-user': DEV_USERS[USER] },
    });
    log('server: cleaned up the demo row');
    setRunning(false);
  }

  return (
    <ScenarioShell
      title="Reconnect rebuilds the cache"
      blurb={
        <>
          Reconnect is a fresh snapshot, never a resumption. This forces a real socket
          disconnect (not a network blip), writes server-side while offline, then reconnects and
          shows the cache converge to the true state in one jump — no delta for the missed write.
        </>
      }
    >
      <p>
        Connection: <strong>{status.state}</strong>
        {status.error && ` — ${status.error.message}`}
      </p>

      <button onClick={() => void run()} disabled={running} style={runButtonStyle(running)}>
        Run simulation
      </button>

      <EventLog events={events} />
    </ScenarioShell>
  );
}
