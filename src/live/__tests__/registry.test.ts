import { describe, expect, it } from 'vitest';
import { InMemorySubscriptionRegistry } from '../registry.js';
import { widgetSubscription } from './support.js';

describe('InMemorySubscriptionRegistry', () => {
  it('indexes by model — forModel never returns another model’s subscriptions', () => {
    const registry = new InMemorySubscriptionRegistry();
    const widget = widgetSubscription('s1', {});
    registry.add(widget);
    registry.add({ ...widget, id: 's2', model: 'Other' });

    expect(registry.forModel('Widget').map((s) => s.id)).toEqual(['s1']);
    expect(registry.forModel('Other').map((s) => s.id)).toEqual(['s2']);
    expect(registry.size).toBe(2);
  });

  it('unsubscribe removes exactly that subscription and is idempotent', () => {
    const registry = new InMemorySubscriptionRegistry();
    const unsub = registry.add(widgetSubscription('s1', {}));
    registry.add(widgetSubscription('s2', {}));

    unsub();
    expect(registry.forModel('Widget').map((s) => s.id)).toEqual(['s2']);
    expect(registry.size).toBe(1);

    unsub(); // second call must not throw or double-decrement
    expect(registry.size).toBe(1);
  });

  it('models() lists only models with at least one live subscription', () => {
    const registry = new InMemorySubscriptionRegistry();
    const unsub = registry.add(widgetSubscription('s1', {}));
    expect(registry.models()).toEqual(['Widget']);
    unsub();
    expect(registry.models()).toEqual([]);
  });
});
