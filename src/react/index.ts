import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { LiveQueryHandle, PgbaseClient } from '../client/index.js';

const EMPTY: readonly never[] = Object.freeze([]);

const NOOP = (): void => {};

export function useLiveQuery<T = unknown>(
  client: PgbaseClient | null | undefined,
  model: string,
  where?: Record<string, unknown>,
): readonly T[] {
  const whereKey = JSON.stringify(where ?? {});
  const [handle, setHandle] = useState<LiveQueryHandle<T> | null>(null);

  useEffect(() => {
    if (!client) return;
    const live = client.liveQuery<T>(model, where);
    setHandle(live);
    return () => {
      // Drop the reference before closing, so a render in between cannot read a dead handle.
      setHandle((current) => (current === live ? null : current));
      live.close();
    };
  }, [client, model, whereKey]);

  const subscribe = useCallback(
    (listener: () => void) => (handle ? handle.subscribe(listener) : NOOP),
    [handle],
  );
  const getSnapshot = useCallback(
    () => (handle ? handle.getSnapshot() : (EMPTY as readonly T[])),
    [handle],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
