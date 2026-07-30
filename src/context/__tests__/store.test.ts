import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { AsyncLocalStorageContextStore, requireContext } from '../store.js';

interface Principal {
  readonly userId: string;
}
interface Claims {
  readonly orgId: string;
}

function ctx(userId: string, orgId: string) {
  return { principal: { userId }, claims: { orgId } };
}

describe('AsyncLocalStorageContextStore', () => {
  it('get() is undefined and isUnscoped() is false outside any scope', () => {
    const store = new AsyncLocalStorageContextStore<Principal, Claims>();
    expect(store.get()).toBeUndefined();
    expect(store.isUnscoped()).toBe(false);
  });

  it('run() establishes scope for the duration of the callback only', () => {
    const store = new AsyncLocalStorageContextStore<Principal, Claims>();
    store.run(ctx('u1', 'o1'), () => {
      expect(store.get()).toEqual(ctx('u1', 'o1'));
      expect(store.isUnscoped()).toBe(false);
    });
    expect(store.get()).toBeUndefined();
  });

  it('nested run(): inner wins, outer is restored afterward', () => {
    const store = new AsyncLocalStorageContextStore<Principal, Claims>();
    store.run(ctx('outer', 'o1'), () => {
      store.run(ctx('inner', 'o2'), () => {
        expect(store.get()).toEqual(ctx('inner', 'o2'));
      });
      expect(store.get()).toEqual(ctx('outer', 'o1'));
    });
  });

  it('run() inside runUnscoped(): re-scoping is allowed', () => {
    const store = new AsyncLocalStorageContextStore<Principal, Claims>();
    store.runUnscoped('background job', () => {
      expect(store.isUnscoped()).toBe(true);
      store.run(ctx('u1', 'o1'), () => {
        expect(store.isUnscoped()).toBe(false);
        expect(store.get()).toEqual(ctx('u1', 'o1'));
      });
      expect(store.isUnscoped()).toBe(true);
      expect(store.get()).toBeUndefined();
    });
  });

  it('runUnscoped() inside run(): allowed, and does not leak back out', () => {
    const store = new AsyncLocalStorageContextStore<Principal, Claims>();
    store.run(ctx('u1', 'o1'), () => {
      store.runUnscoped('one-off maintenance read', () => {
        expect(store.isUnscoped()).toBe(true);
        expect(store.get()).toBeUndefined();
      });
      expect(store.isUnscoped()).toBe(false);
      expect(store.get()).toEqual(ctx('u1', 'o1'));
    });
  });

  it('propagates across await', async () => {
    const store = new AsyncLocalStorageContextStore<Principal, Claims>();
    await store.run(ctx('u1', 'o1'), async () => {
      await delay(5);
      expect(store.get()).toEqual(ctx('u1', 'o1'));
    });
  });

  it('propagates across setTimeout', async () => {
    const store = new AsyncLocalStorageContextStore<Principal, Claims>();
    await new Promise<void>((resolve) => {
      store.run(ctx('u1', 'o1'), () => {
        setTimeout(() => {
          expect(store.get()).toEqual(ctx('u1', 'o1'));
          resolve();
        }, 5);
      });
    });
  });

  it('Promise.all branches carry their own, independent context', async () => {
    const store = new AsyncLocalStorageContextStore<Principal, Claims>();
    async function readAfter(ms: number) {
      await delay(ms);
      return store.get();
    }
    const [a, b] = await Promise.all([
      store.run(ctx('a', 'oa'), () => readAfter(10)),
      store.run(ctx('b', 'ob'), () => readAfter(1)),
    ]);
    expect(a).toEqual(ctx('a', 'oa'));
    expect(b).toEqual(ctx('b', 'ob'));
    expect(store.get()).toBeUndefined();
  });
});

describe('requireContext', () => {
  it('throws outside any scope, naming the opt-out', () => {
    const store = new AsyncLocalStorageContextStore<Principal, Claims>();
    expect(() => requireContext(store)).toThrow(/runUnscoped/);
  });

  it('returns the established context inside run()', () => {
    const store = new AsyncLocalStorageContextStore<Principal, Claims>();
    store.run(ctx('u1', 'o1'), () => {
      expect(requireContext(store)).toEqual(ctx('u1', 'o1'));
    });
  });

  it('still throws inside runUnscoped() — that is the whole point of the opt-out', () => {
    const store = new AsyncLocalStorageContextStore<Principal, Claims>();
    store.runUnscoped('cron', () => {
      expect(() => requireContext(store)).toThrow(/runUnscoped/);
    });
  });
});
