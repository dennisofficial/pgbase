import { AsyncLocalStorage } from 'node:async_hooks';
import type { ContextStore, RequestContext } from './types.js';

export class AsyncLocalStorageContextStore<
  Principal = unknown,
  Claims = unknown,
> implements ContextStore<Principal, Claims> {
  private readonly als = new AsyncLocalStorage<RequestContext<Principal, Claims>>();

  run<T>(ctx: RequestContext<Principal, Claims>, fn: () => T): T {
    return this.als.run(ctx, fn);
  }

  get(): RequestContext<Principal, Claims> | undefined {
    return this.als.getStore();
  }
}

export function requireContext<Principal, Claims>(
  store: ContextStore<Principal, Claims>,
): RequestContext<Principal, Claims> {
  const ctx = store.get();
  if (ctx !== undefined) return ctx;
  throw new Error(
    "No pgbase request context. A scoped read derives its row filter from the caller's claims, " +
      'so it can only run while a request is in flight — PgbaseContextMiddleware establishes ' +
      'that context. This call reached a scoped delegate from somewhere else: a cron, a queue ' +
      'worker, a startup hook, or work that outlived the request that began it. Server-side work ' +
      'with no caller to scope to should use your PrismaClient directly.',
  );
}
