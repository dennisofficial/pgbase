import type { PgbaseCore } from './core.js';
import type { FindManyArgs, FindOneArgs, ModelAccessor } from './types.js';

export function createModelAccessor<T>(core: PgbaseCore, model: string): ModelAccessor<T> {
  return {
    async findMany(args: FindManyArgs = {}): Promise<readonly T[]> {
      return (await core.read(model, args)) as readonly T[];
    },

    async findOne(args: FindOneArgs = {}): Promise<T | null> {
      const rows = (await core.read(model, { ...args, take: 1 })) as readonly T[];
      return rows[0] ?? null;
    },

    subscribeMany({ where, onUpdate, onError }): () => void {
      const subscription = core.createSubscription<T>(model);
      const off = subscription.subscribe(onUpdate);
      void subscription.query({ where }).catch((err) => onError?.(err as Error));
      return () => {
        off();
        subscription.close();
      };
    },

    subscribeOne({ where, onUpdate, onError }): () => void {
      const subscription = core.createSubscription<T>(model);
      const off = subscription.subscribe((rows) => onUpdate(rows[0] ?? null));
      void subscription.query({ where }).catch((err) => onError?.(err as Error));
      return () => {
        off();
        subscription.close();
      };
    },

    createSubscription() {
      return core.createSubscription<T>(model);
    },
  };
}
