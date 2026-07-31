---
'@dltech/pgbase': patch
---

Fix a model being unsubscribable when its policy omits a column its own RLS predicate references. `createSubscription` validated the server-authored RLS predicate against the _client's_ filterable set, so `{ omit: ['actorId'], rls: (c) => ({ actorId: { equals: c.userId } }) }` failed with `Unknown or disallowed filter field "actorId"` — while one-shot reads of the same model worked, since the read path only holds client input to that set. The policy predicate is now checked against the model's fields; the client's own `where` is still restricted to filterable columns, and omitted columns are still stripped from every payload.
