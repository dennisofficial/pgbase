'use client';

import { useCallback, useState } from 'react';

export interface LogEntry {
  readonly id: number;
  readonly at: string;
  readonly text: string;
}

let nextLogId = 0;

export function useEventLog() {
  const [events, setEvents] = useState<readonly LogEntry[]>([]);

  const log = useCallback((text: string) => {
    setEvents((prev) => [...prev, { id: nextLogId++, at: new Date().toLocaleTimeString(), text }]);
  }, []);

  const clear = useCallback(() => setEvents([]), []);

  return { events, log, clear };
}

export function EventLog({ events }: { events: readonly LogEntry[] }) {
  return (
    <ul
      style={{
        listStyle: 'none',
        margin: '0.5rem 0',
        padding: '0.6rem 0.8rem',
        background: '#f7f7f7',
        border: '1px solid #ddd',
        borderRadius: 4,
        maxHeight: '16rem',
        overflowY: 'auto',
        fontFamily: 'ui-monospace, Menlo, monospace',
        fontSize: '0.82rem',
      }}
    >
      {events.length === 0 && <li style={{ color: '#999' }}>No events yet — run the simulation.</li>}
      {events.map((e) => (
        <li key={e.id} style={{ padding: '0.1rem 0' }}>
          <span style={{ color: '#999' }}>{e.at}</span> {e.text}
        </li>
      ))}
    </ul>
  );
}
