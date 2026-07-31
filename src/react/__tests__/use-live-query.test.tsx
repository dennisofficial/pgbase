// @vitest-environment jsdom
// React only double-invokes effects under StrictMode in its DEVELOPMENT build, and the production
// build makes StrictMode a no-op. Test runners default to production, so without this the case
// this file exists to cover silently does not run.
// Set before React loads. `import` statements are hoisted, so React has to come in dynamically
// below or it initialises in production mode regardless of what this line says.
process.env.NODE_ENV = 'development';

import type { createRoot as CreateRoot } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type LiveSocket, type ModelAccessor } from '../../client/index.js';
import { PGBASE_SUBSCRIBE, PGBASE_UNSUBSCRIBE } from '../../live/protocol.js';
import { useLiveQuery } from '../index.js';

type Root = ReturnType<typeof CreateRoot>;

// Loaded in beforeAll rather than by a top-level import so the NODE_ENV above lands first.
let StrictMode: typeof import('react').StrictMode;
let act: typeof import('react').act;
let createElement: typeof import('react').createElement;
let createRoot: typeof CreateRoot;

beforeAll(async () => {
  ({ StrictMode, act, createElement } = await import('react'));
  ({ createRoot } = await import('react-dom/client'));
});

interface Job {
  readonly id: number;
}

interface Sent {
  readonly event: string;
  readonly payload: any;
}

/** Records what the hook actually put on the wire, which is the thing that was going wrong. */
function fakeSocket() {
  const sent: Sent[] = [];
  const listeners = new Map<string, ((...args: any[]) => void)[]>();
  let nextId = 0;

  const socket: LiveSocket = {
    connected: true,
    on(event: string, listener: (...args: any[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return socket;
    },
    off(event: string, listener: (...args: any[]) => void) {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((l) => l !== listener),
      );
      return socket;
    },
    emit(event: string, payload: unknown, ack?: (res: unknown) => void) {
      sent.push({ event, payload });
      if (event === PGBASE_SUBSCRIBE) {
        ack?.({
          ok: true,
          subscriptionId: `sub-${++nextId}`,
          primaryKey: ['id'],
          snapshot: { json: [], meta: undefined },
        });
      } else {
        ack?.({ ok: true });
      }
      return socket;
    },
  } as unknown as LiveSocket;

  const count = (event: string) => sent.filter((s) => s.event === event).length;
  const issuedIds = () =>
    sent.filter((s) => s.event === PGBASE_SUBSCRIBE).map((_, i) => `sub-${i + 1}`);
  const emitDelta = (subscriptionId: string, row: Record<string, unknown>) => {
    for (const l of listeners.get('pgbase:delta') ?? []) {
      l({ json: { kind: 'upsert', subscriptionId, row }, meta: undefined });
    }
  };
  return { socket, sent, count, issuedIds, emitDelta };
}

function fakeAccessor(socket: LiveSocket): ModelAccessor<Job> {
  const db = createClient<{ Job: Job }>({ baseUrl: 'http://test', createSocket: () => socket });
  return db.Job;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function Probe({ accessor }: { accessor: ModelAccessor<Job> }) {
  const rows = useLiveQuery(accessor);
  return createElement('span', null, String(rows.length));
}

describe('useLiveQuery', () => {
  it('still receives deltas after a StrictMode double-mount', async () => {
    // The symptom this guards is "realtime silently stops". React mounts, unmounts, and remounts
    // effects in development. Subscribing during render instead leaves the component holding a
    // handle that was closed, while a second, orphaned subscription stays bound server-side and
    // absorbs the deltas — the UI goes quiet with nothing in the console to explain it.
    const { socket, count, issuedIds, emitDelta } = fakeSocket();
    const accessor = fakeAccessor(socket);

    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(Probe, { accessor })));
    });

    // Deliver a row on every subscription the client ever opened. Whichever one is still bound,
    // the mounted component must be the thing that sees it.
    await act(async () => {
      for (const id of issuedIds()) emitDelta(id, { id: 1 });
    });

    expect(container.textContent).toBe('1');
    // And exactly one subscription is left alive, not one live plus one orphan.
    expect(count(PGBASE_SUBSCRIBE) - count(PGBASE_UNSUBSCRIBE)).toBe(1);
  });

  it('closes its subscription when the component unmounts', async () => {
    const { socket, count } = fakeSocket();
    const accessor = fakeAccessor(socket);

    await act(async () => {
      root.render(createElement(Probe, { accessor }));
    });
    expect(count(PGBASE_SUBSCRIBE) - count(PGBASE_UNSUBSCRIBE)).toBe(1);

    await act(async () => {
      root.render(createElement('span', null, 'gone'));
    });
    // A subscription that outlives its component keeps the server routing work alive forever.
    expect(count(PGBASE_SUBSCRIBE) - count(PGBASE_UNSUBSCRIBE)).toBe(0);
  });

  it('subscribes nothing until an accessor exists', async () => {
    const { socket, count } = fakeSocket();
    void socket;
    function NoAccessor() {
      const rows = useLiveQuery<Job>(null);
      return createElement('span', null, String(rows.length));
    }
    await act(async () => {
      root.render(createElement(NoAccessor));
    });
    expect(count(PGBASE_SUBSCRIBE)).toBe(0);
  });
});
