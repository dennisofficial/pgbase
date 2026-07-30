import type { ClaimsBuilder, ClaimsCache, ClaimsCacheStats } from './types.js';

interface CacheEntry<Claims> {
  readonly claims: Claims;
  readonly expiresAt: number;
}

interface InflightBox {
  invalidated: boolean;
}

interface InflightEntry<Claims> {
  readonly promise: Promise<Claims>;
  readonly box: InflightBox;
}

export interface MemoryClaimsCacheOptions {
  readonly maxSize?: number;
}

const DEFAULT_MAX_SIZE = 10_000;

export class MemoryClaimsCache<Principal = unknown, Claims = unknown> implements ClaimsCache<
  Principal,
  Claims
> {
  private readonly cache = new Map<string, CacheEntry<Claims>>();
  private readonly inflight = new Map<string, InflightEntry<Claims>>();
  private readonly maxSize: number;
  private readonly counters = { hits: 0, misses: 0, coalesced: 0 };

  constructor(
    private readonly builder: ClaimsBuilder<Principal, Claims>,
    options: MemoryClaimsCacheOptions = {},
  ) {
    this.maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
  }

  get stats(): ClaimsCacheStats {
    return { ...this.counters };
  }

  get(principal: Principal): Promise<Claims> {
    const key = this.builder.key(principal);

    const inflight = this.inflight.get(key);
    if (inflight) {
      this.counters.coalesced++;
      return inflight.promise;
    }

    const cached = this.cache.get(key);
    if (cached) {
      if (cached.expiresAt > Date.now()) {
        this.cache.delete(key);
        this.cache.set(key, cached); // move to MRU position
        this.counters.hits++;
        return Promise.resolve(cached.claims);
      }
      this.cache.delete(key); // lazy TTL expiry
    }

    this.counters.misses++;
    return this.startBuild(key, principal);
  }

  invalidate(key: string): void {
    this.cache.delete(key);
    const inflight = this.inflight.get(key);
    if (inflight) {
      inflight.box.invalidated = true;
      this.inflight.delete(key);
    }
  }

  invalidateAll(): void {
    this.cache.clear();
    for (const entry of this.inflight.values()) entry.box.invalidated = true;
    this.inflight.clear();
  }

  private startBuild(key: string, principal: Principal): Promise<Claims> {
    const box: InflightBox = { invalidated: false };
    const promise = this.builder.build(principal).then(
      (claims) => {
        this.inflight.delete(key);
        if (!box.invalidated) this.store(key, claims);
        return claims;
      },
      (err: unknown) => {
        this.inflight.delete(key); // not cached — the next get() retries
        throw err;
      },
    );
    this.inflight.set(key, { promise, box });
    return promise;
  }

  private store(key: string, claims: Claims): void {
    const ttlMs = this.builder.ttlMs;
    const expiresAt = ttlMs === undefined ? Infinity : Date.now() + ttlMs;
    this.cache.set(key, { claims, expiresAt });
    while (this.cache.size > this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
