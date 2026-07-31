import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PgbaseModuleOptions } from '../../nest/types.js';
import type { MemoryClaimsCacheOptions } from '../claims-cache.js';
import { MemoryClaimsCache } from '../claims-cache.js';
import type { ClaimsBuilder } from '../types.js';

interface Principal {
  readonly userId: string;
}
interface Claims {
  readonly orgId: string;
}

function deferredBuilder(ttlMs?: number) {
  const resolvers: Array<(claims: Claims) => void> = [];
  const rejecters: Array<(err: unknown) => void> = [];
  const calls: Principal[] = [];
  const builder: ClaimsBuilder<Principal, Claims> = {
    key: (p) => p.userId,
    ttlMs,
    build: (p) =>
      new Promise<Claims>((resolve, reject) => {
        calls.push(p);
        resolvers.push(resolve);
        rejecters.push(reject);
      }),
  };
  return { builder, resolvers, rejecters, calls };
}

function cacheFor(
  claimsBuilder: ClaimsBuilder<Principal, Claims>,
  claimsCacheOptions?: MemoryClaimsCacheOptions,
) {
  return new MemoryClaimsCache<Principal, Claims>({
    claimsBuilder,
    claimsCacheOptions,
  } as unknown as PgbaseModuleOptions<Principal, Claims>);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MemoryClaimsCache — single-flight', () => {
  it('20 parallel get() on a cold key: build() called exactly once, all resolve to the same value', async () => {
    let buildCalls = 0;
    const builder: ClaimsBuilder<Principal, Claims> = {
      key: (p) => p.userId,
      build: async (p) => {
        buildCalls++;
        await delay(10);
        return { orgId: `org-of-${p.userId}` };
      },
    };
    const cache = cacheFor(builder);
    const principal: Principal = { userId: 'u1' };

    const results = await Promise.all(Array.from({ length: 20 }, () => cache.get(principal)));

    expect(buildCalls).toBe(1);
    expect(results).toHaveLength(20);
    expect(results.every((r) => r === results[0])).toBe(true);
    expect(cache.stats.misses).toBe(1);
    expect(cache.stats.coalesced).toBe(19);
  });

  it('a rejecting build() rejects every joined caller and is not cached; the next call retries', async () => {
    let attempt = 0;
    const builder: ClaimsBuilder<Principal, Claims> = {
      key: (p) => p.userId,
      build: async (p) => {
        attempt++;
        if (attempt === 1) throw new Error('transient db blip');
        return { orgId: `org-of-${p.userId}` };
      },
    };
    const cache = cacheFor(builder);
    const principal: Principal = { userId: 'u1' };

    const [r1, r2, r3] = await Promise.allSettled([
      cache.get(principal),
      cache.get(principal),
      cache.get(principal),
    ]);
    expect(r1.status).toBe('rejected');
    expect(r2.status).toBe('rejected');
    expect(r3.status).toBe('rejected');
    expect(cache.stats.coalesced).toBe(2);

    const claims = await cache.get(principal);
    expect(claims).toEqual({ orgId: 'org-of-u1' });
    expect(attempt).toBe(2);
  });
});

describe('MemoryClaimsCache — TTL', () => {
  it('expiry is lazy: a stale entry is only detected (and rebuilt) on the next read', async () => {
    let attempt = 0;
    const builder: ClaimsBuilder<Principal, Claims> = {
      key: (p) => p.userId,
      ttlMs: 1000,
      build: async (p) => {
        attempt++;
        return { orgId: `org-${p.userId}-${attempt}` };
      },
    };
    const cache = cacheFor(builder);
    const principal: Principal = { userId: 'u1' };
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now);

    const first = await cache.get(principal);
    expect(cache.stats.misses).toBe(1);

    spy.mockReturnValue(now + 500);
    const second = await cache.get(principal);
    expect(second).toBe(first);
    expect(cache.stats.hits).toBe(1);

    spy.mockReturnValue(now + 1500);
    const third = await cache.get(principal);
    expect(third).not.toEqual(first);
    expect(cache.stats.misses).toBe(2);
  });

  it('no ttlMs means entries never expire on their own', async () => {
    let attempt = 0;
    const builder: ClaimsBuilder<Principal, Claims> = {
      key: (p) => p.userId,
      build: async (p) => {
        attempt++;
        return { orgId: `org-${p.userId}-${attempt}` };
      },
    };
    const cache = cacheFor(builder);
    const principal: Principal = { userId: 'u1' };
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now());

    await cache.get(principal);
    spy.mockReturnValue(Date.now() + 1000 * 60 * 60 * 24 * 365);
    await cache.get(principal);

    expect(attempt).toBe(1);
    expect(cache.stats.hits).toBe(1);
  });
});

describe('MemoryClaimsCache — LRU eviction', () => {
  it('exceeding maxSize evicts the least-recently-used key, not the most recently touched one', async () => {
    const builder: ClaimsBuilder<Principal, Claims> = {
      key: (p) => p.userId,
      build: async (p) => ({ orgId: `org-${p.userId}` }),
    };
    const cache = cacheFor(builder, { maxSize: 2 });

    await cache.get({ userId: 'a' });
    await cache.get({ userId: 'b' });
    await cache.get({ userId: 'a' }); // touch "a" -> now MRU, "b" is LRU
    await cache.get({ userId: 'c' }); // cache is at maxSize; inserting evicts "b"

    const hitsBefore = cache.stats.hits;
    await cache.get({ userId: 'a' }); // survived the eviction
    expect(cache.stats.hits).toBe(hitsBefore + 1);

    const missesBefore = cache.stats.misses;
    await cache.get({ userId: 'b' }); // was evicted -> must rebuild
    expect(cache.stats.misses).toBe(missesBefore + 1);
  });
});

describe('MemoryClaimsCache — invalidate during an in-flight build', () => {
  it('a joined caller still resolves with the in-flight result, but it is never cached', async () => {
    const { builder, resolvers, calls } = deferredBuilder();
    const cache = cacheFor(builder);

    const pending = cache.get({ userId: 'u1' });
    cache.invalidate('u1');
    resolvers[0]!({ orgId: 'stale' });

    await expect(pending).resolves.toEqual({ orgId: 'stale' });

    // Not served from the cache: starting a fresh build synchronously calls build() again.
    const callsBefore = calls.length;
    cache.get({ userId: 'u1' });
    expect(calls.length).toBe(callsBefore + 1);
  });

  it('get() after invalidate() during an in-flight build starts a fresh build, not a join', async () => {
    const { builder, resolvers, calls } = deferredBuilder();
    const cache = cacheFor(builder);

    const pending1 = cache.get({ userId: 'u1' });
    cache.invalidate('u1');
    const pending2 = cache.get({ userId: 'u1' });

    expect(calls).toHaveLength(2);
    expect(cache.stats.coalesced).toBe(0);

    resolvers[0]!({ orgId: 'stale' });
    resolvers[1]!({ orgId: 'fresh' });
    await expect(pending1).resolves.toEqual({ orgId: 'stale' });
    await expect(pending2).resolves.toEqual({ orgId: 'fresh' });

    const hit = await cache.get({ userId: 'u1' });
    expect(hit).toEqual({ orgId: 'fresh' });
  });

  it('an invalidated build resolving AFTER a fresher one does not clobber the cache', async () => {
    const { builder, resolvers } = deferredBuilder();
    const cache = cacheFor(builder);

    const pending1 = cache.get({ userId: 'u1' }); // build #1
    cache.invalidate('u1');
    const pending2 = cache.get({ userId: 'u1' }); // build #2, fresh

    resolvers[1]!({ orgId: 'fresh' }); // #2 resolves and caches first
    await pending2;
    resolvers[0]!({ orgId: 'stale' }); // #1 (invalidated) resolves after
    await pending1;

    const hit = await cache.get({ userId: 'u1' });
    expect(hit).toEqual({ orgId: 'fresh' });
  });

  it('invalidateAll() clears the cache and every in-flight build for every key', async () => {
    const { builder, resolvers, calls } = deferredBuilder();
    const cache = cacheFor(builder);

    const pendingA = cache.get({ userId: 'a' });
    const pendingB = cache.get({ userId: 'b' });
    cache.invalidateAll();

    resolvers[0]!({ orgId: 'stale-a' });
    resolvers[1]!({ orgId: 'stale-b' });
    await pendingA;
    await pendingB;

    // Neither result should have been cached -> a fresh get() starts a third build synchronously.
    const callsBefore = calls.length;
    cache.get({ userId: 'a' });
    expect(calls.length).toBe(callsBefore + 1);
  });
});
