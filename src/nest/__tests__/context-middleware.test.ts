import { describe, expect, it, vi } from 'vitest';
import { AsyncLocalStorageContextStore, MemoryClaimsCache } from '../../context/index.js';
import { PgbaseContextMiddleware } from '../context-middleware.js';
import type { PgbaseModuleOptions } from '../types.js';

function build(getPrincipal: (req: unknown) => unknown) {
  const claimsCache = new MemoryClaimsCache({
    key: (p) => String(p),
    build: async () => ({ ok: true }),
  });
  const store = new AsyncLocalStorageContextStore();
  const middleware = new PgbaseContextMiddleware(
    { getPrincipal } as unknown as PgbaseModuleOptions,
    claimsCache,
    store,
  );
  return { middleware, store };
}

describe('PgbaseContextMiddleware', () => {
  it('lets a CORS preflight through without resolving a principal', async () => {
    const getPrincipal = vi.fn(() => {
      throw new Error('should never be consulted for a preflight');
    });
    const { middleware } = build(getPrincipal);

    const next = vi.fn();
    await middleware.use({ method: 'OPTIONS', headers: {} }, {}, next);

    expect(getPrincipal).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it('still authenticates the real request that follows', async () => {
    const { middleware, store } = build(() => 'user-1');
    let seen: unknown;
    await middleware.use({ method: 'POST', headers: {} }, {}, () => {
      seen = store.get();
    });
    expect(seen).toEqual({ principal: 'user-1', claims: { ok: true } });
  });

  it('passes a rejected principal to the error handler rather than throwing', async () => {
    const boom = new Error('no credentials');
    const { middleware } = build(() => {
      throw boom;
    });
    const next = vi.fn();
    await middleware.use({ method: 'GET', headers: {} }, {}, next);
    expect(next).toHaveBeenCalledWith(boom);
  });
});
