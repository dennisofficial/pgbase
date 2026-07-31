'use client';

import { useState } from 'react';
import { EventLog, useEventLog } from '../../../components/event-log';
import { ScenarioShell, runButtonStyle } from '../../../components/scenario-shell';
import { API_URL, DEV_USERS, pgbase } from '../../../pgbase/client';

const USER = 'alice' as const;

interface RawAuditLogRow {
  readonly id: string;
  readonly action: string;
  readonly actorId: string | null;
  readonly at: string;
}

export default function OmittedColumnsPage() {
  const [running, setRunning] = useState(false);
  const [clientFields, setClientFields] = useState<readonly string[] | null>(null);
  const [raw, setRaw] = useState<RawAuditLogRow | null>(null);
  const { events, log, clear } = useEventLog();

  async function run() {
    if (running) return;
    setRunning(true);
    clear();
    setClientFields(null);
    setRaw(null);

    const res = await fetch(`${API_URL}/simulations/audit-log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pgbase-dev-user': DEV_USERS[USER] },
      body: JSON.stringify({ actorId: DEV_USERS[USER], action: 'demo.simulated-write' }),
    });
    const created: { id: string } = await res.json();
    log(`server: created AuditLog row ${created.id} with action="demo.simulated-write"`);

    const row = await pgbase.AuditLog.findOne({ where: { id: created.id } });
    const fields = row ? Object.keys(row) : [];
    setClientFields(fields);
    log(`client: findOne returned fields [${fields.join(', ')}] — action/actorId/at absent`);

    const rawRes = await fetch(`${API_URL}/simulations/audit-log/${created.id}/raw`, {
      headers: { 'x-pgbase-dev-user': DEV_USERS[USER] },
    });
    const rawRow: RawAuditLogRow = await rawRes.json();
    setRaw(rawRow);
    log(`server (raw, bypassing pgbase): action="${rawRow.action}" actorId=${rawRow.actorId} at=${rawRow.at}`);

    await fetch(`${API_URL}/simulations/audit-log/${created.id}`, {
      method: 'DELETE',
      headers: { 'x-pgbase-dev-user': DEV_USERS[USER] },
    });
    log('server: cleaned up the demo row');
    setRunning(false);
  }

  return (
    <ScenarioShell
      title="Omitted columns never arrive"
      blurb={
        <>
          <code>AuditLog</code>&apos;s policy omits <code>action</code>, <code>actorId</code>, and{' '}
          <code>at</code> — every column but its primary key. The simulation writes a row with all
          three set, then shows what the client actually received next to what is really in the
          database.
        </>
      }
    >
      <p style={{ background: '#fff3cd', border: '1px solid #f0d78c', borderRadius: 4, padding: '0.6rem 0.8rem' }}>
        This uses <code>findOne</code> rather than a live subscription. <code>AuditLog</code>&apos;s
        primary key is a Postgres <code>int8</code>, which arrives client-side as a JS{' '}
        <code>bigint</code>; the subscription cache&apos;s row-identity helper (<code>keyOf</code>{' '}
        in <code>src/live/protocol.ts</code>) builds each row&apos;s key with{' '}
        <code>JSON.stringify</code>, which throws on <code>bigint</code>. That is a pgbase bug, not
        something this example app works around — see the report for this task.
      </p>

      <button onClick={() => void run()} disabled={running} style={runButtonStyle(running)}>
        Run simulation
      </button>

      <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
        <div style={{ flex: 1, border: '1px solid #ddd', borderRadius: 6, padding: '0.7rem' }}>
          <strong>What the client received (findOne)</strong>
          <p style={{ margin: '0.4rem 0 0' }}>
            {clientFields ? `{ ${clientFields.join(', ')} }` : '—'}
          </p>
        </div>
        <div style={{ flex: 1, border: '1px solid #ddd', borderRadius: 6, padding: '0.7rem' }}>
          <strong>What&apos;s actually in the row (raw, admin-only)</strong>
          <p style={{ margin: '0.4rem 0 0' }}>
            {raw ? `action="${raw.action}", actorId=${raw.actorId}, at=${raw.at}` : '—'}
          </p>
        </div>
      </div>

      <EventLog events={events} />
    </ScenarioShell>
  );
}
