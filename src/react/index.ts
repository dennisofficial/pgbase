import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { LiveArgs, ModelAccessor, Subscription } from '../client/index.js';

const EMPTY: readonly never[] = Object.freeze([]);

const NOOP = (): void => {};

export function useLiveQuery<T>(
  accessor: ModelAccessor<T> | null | undefined,
  args?: LiveArgs,
): readonly T[] {
  const whereKey = JSON.stringify(args?.where ?? {});
  const [subscription, setSubscription] = useState<Subscription<T> | null>(null);

  useEffect(() => {
    if (!accessor) return;
    const sub = accessor.createSubscription();
    setSubscription(sub);
    void sub.query({ where: args?.where });
    return () => {
      // Drop the reference before closing, so a render in between cannot read a dead handle.
      setSubscription((current) => (current === sub ? null : current));
      sub.close();
    };
  }, [accessor, whereKey]);

  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      subscription ? subscription.subscribe(() => onStoreChange()) : NOOP,
    [subscription],
  );
  const getSnapshot = useCallback(
    () => (subscription ? subscription.getSnapshot() : (EMPTY as readonly T[])),
    [subscription],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
