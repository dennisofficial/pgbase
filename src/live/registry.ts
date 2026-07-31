import type { Subscription, SubscriptionRegistry } from './types.js';

export class InMemorySubscriptionRegistry implements SubscriptionRegistry {
  private readonly byModel = new Map<string, Set<Subscription>>();

  add(subscription: Subscription): () => void {
    let set = this.byModel.get(subscription.model);
    if (!set) {
      set = new Set();
      this.byModel.set(subscription.model, set);
    }
    set.add(subscription);

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      set!.delete(subscription);
      if (set!.size === 0) this.byModel.delete(subscription.model);
    };
  }

  forModel(model: string): readonly Subscription[] {
    const set = this.byModel.get(model);
    return set ? [...set] : [];
  }

  models(): readonly string[] {
    return [...this.byModel.keys()];
  }

  get size(): number {
    let total = 0;
    for (const set of this.byModel.values()) total += set.size;
    return total;
  }
}
