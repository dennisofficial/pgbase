import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { PgbasePoolHost } from '../pool.js';
import type { PgbaseModuleOptions } from '../types.js';

function host(options: Partial<PgbaseModuleOptions>): PgbasePoolHost {
  return new PgbasePoolHost(options as PgbaseModuleOptions);
}

describe('PgbasePoolHost', () => {
  it('refuses both a pool and a connection string, rather than silently preferring one', () => {
    const pool = { end: vi.fn() } as unknown as Pool;
    expect(() => host({ pool, connectionString: 'postgresql://x/y' })).toThrow(/not both/);
  });

  it('refuses neither', () => {
    expect(() => host({})).toThrow(/no database connection/);
  });

  // Ending a pool the app also queries through would close connections out from under it.
  it('leaves a borrowed pool open at shutdown', async () => {
    const end = vi.fn();
    const pool = { end } as unknown as Pool;
    const subject = host({ pool });

    expect(subject.pool).toBe(pool);
    await subject.onApplicationShutdown();
    expect(end).not.toHaveBeenCalled();
  });

  it('ends a pool it built itself', async () => {
    const subject = host({ connectionString: 'postgresql://user:pw@127.0.0.1:1/nowhere' });
    const end = vi.spyOn(subject.pool, 'end').mockResolvedValue(undefined);

    await subject.onApplicationShutdown();
    expect(end).toHaveBeenCalledOnce();
  });
});
