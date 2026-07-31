import type { LiveArgs, ModelAccessor, Subscription } from './types.js';

export interface RtkCacheLifecycleApi<T> {
  readonly cacheDataLoaded: PromiseLike<{ readonly meta?: unknown }>;
  readonly cacheEntryRemoved: PromiseLike<void>;
  updateCachedData(recipe: (draft: readonly T[]) => readonly T[] | void): unknown;
}

export interface LiveQueryMeta<T> {
  readonly subscription: Subscription<T>;
}

export type LiveQueryResult<T> =
  | { readonly data: readonly T[]; readonly meta: LiveQueryMeta<T>; readonly error?: undefined }
  | { readonly error: string; readonly data?: undefined; readonly meta?: undefined };

/**
 * For `configureStore({ middleware: (d) => d({ serializableCheck: { isSerializable } }) })`. Rows
 * keep the Prisma types they were read with, so RTK's plain-JSON default rejects every cache entry
 * a delta touches. Compose to admit custom `serializers`: `(v) => isLiveSerializable(v) || ...`.
 */
export function isLiveSerializable(value: unknown): boolean {
  switch (typeof value) {
    case 'undefined':
    case 'string':
    case 'number':
    case 'boolean':
    case 'bigint':
      return true;
    case 'object':
      break;
    default:
      return false;
  }
  if (value === null || Array.isArray(value) || value instanceof Date) return true;
  if (ArrayBuffer.isView(value)) return true;
  if (typeof (value as { toFixed?: unknown }).toFixed === 'function') return true;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === null || proto === Object.prototype;
}

export function liveQueryEndpoint<T, Arg = void>(
  accessor: ModelAccessor<T>,
  toArgs: (arg: Arg) => LiveArgs = () => ({}),
): {
  queryFn: (arg: Arg) => Promise<LiveQueryResult<T>>;
  onCacheEntryAdded: (arg: Arg, api: RtkCacheLifecycleApi<T>) => Promise<void>;
} {
  return {
    async queryFn(arg) {
      const subscription = accessor.createSubscription();
      try {
        const data = await subscription.query(toArgs(arg));
        return { data, meta: { subscription } };
      } catch (err) {
        subscription.close();
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    async onCacheEntryAdded(_arg, api) {
      const { meta } = await api.cacheDataLoaded;
      const subscription = (meta as LiveQueryMeta<T> | undefined)?.subscription;
      if (!subscription) return;
      const off = subscription.subscribe((rows) => api.updateCachedData(() => rows));
      await api.cacheEntryRemoved;
      off();
      subscription.close();
    },
  };
}
