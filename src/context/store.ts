import { AsyncLocalStorage } from 'node:async_hooks';
import type { ContextStore, RequestContext } from './types.js';

type Frame<Principal, Claims> =
  | { readonly scoped: true; readonly ctx: RequestContext<Principal, Claims> }
  | { readonly scoped: false; readonly reason: string };

export class AsyncLocalStorageContextStore<
  Principal = unknown,
  Claims = unknown,
> implements ContextStore<Principal, Claims> {
  private readonly als = new AsyncLocalStorage<Frame<Principal, Claims>>();

  run<T>(ctx: RequestContext<Principal, Claims>, fn: () => T): T {
    return this.als.run({ scoped: true, ctx }, fn);
  }

  get(): RequestContext<Principal, Claims> | undefined {
    const frame = this.als.getStore();
    return frame?.scoped ? frame.ctx : undefined;
  }

  runUnscoped<T>(reason: string, fn: () => T): T {
    return this.als.run({ scoped: false, reason }, fn);
  }

  isUnscoped(): boolean {
    const frame = this.als.getStore();
    return frame !== undefined && !frame.scoped;
  }
}

export function requireContext<Principal, Claims>(
  store: ContextStore<Principal, Claims>,
): RequestContext<Principal, Claims> {
  const ctx = store.get();
  if (ctx !== undefined) return ctx;
  throw new Error(
    'no pgbase request scope — wrap this call in `contextStore.run(...)`, or opt out ' +
      "explicitly with `contextStore.runUnscoped('<reason>', ...)`.",
  );
}
