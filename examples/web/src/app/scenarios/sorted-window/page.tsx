import { ScenarioShell } from '../../../components/scenario-shell';

export default function SortedWindowPage() {
  return (
    <ScenarioShell
      title="(Not supported) Sorted top-N live window"
      blurb="Why a live 'top 10 by priority, watch items enter and leave' page cannot be built today."
    >
      <p>
        A live subscription is <code>{'{ model, where }'}</code> — see{' '}
        <code>SubscribeRequest</code> in <code>src/live/protocol.ts</code>. There is no{' '}
        <code>orderBy</code> and no <code>take</code>.
      </p>
      <p>
        The router decides whether a changed row belongs in a subscription by evaluating that
        subscription&apos;s predicate against the row alone (see <code>src/live/router.ts</code>).
        That works for a filter like <code>{'{ status: "RUNNING" }'}</code>, because membership is
        a property of the row by itself.
      </p>
      <p>
        It cannot work for &quot;top 10 by priority&quot;. Whether a row belongs in that window
        depends on every <em>other</em> row&apos;s priority, not on anything in the changed row.
        A new row with priority 9 needs to evict whichever row is currently 10th — the router has
        no way to know which row that is, or even that an eviction is needed, from the changed row
        alone. Supporting this would need the server to track ordered windows per subscription
        and re-evaluate the whole window on every write in that model, which is a materially
        different (and more expensive) design than per-row predicate routing.
      </p>
      <p>
        A client-side sort over an unbounded <code>subscribeMany</code> result can approximate the
        top N as a UI-only view, but it is not a live window: a row that would enter the true top
        10 but isn&apos;t in the subscription&apos;s <code>where</code> at all never arrives, and the
        client has no way to know it&apos;s missing one. This page intentionally does not fake that
        with a client-side sort.
      </p>
    </ScenarioShell>
  );
}
