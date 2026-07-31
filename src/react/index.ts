import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { PgbaseClient } from '../client/index.js';

export function useLiveQuery<T = unknown>(
  client: PgbaseClient,
  model: string,
  where?: Record<string, unknown>,
): readonly T[] {
  const whereKey = JSON.stringify(where ?? {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handle = useMemo(() => client.liveQuery<T>(model, where), [client, model, whereKey]);

  useEffect(() => () => handle.close(), [handle]);

  return useSyncExternalStore(handle.subscribe, handle.getSnapshot, handle.getSnapshot);
}
