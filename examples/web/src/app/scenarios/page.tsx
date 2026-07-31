import Link from 'next/link';

const SCENARIOS = [
  {
    href: '/scenarios/watch-delete',
    title: 'Watching one row that gets deleted',
    blurb: 'subscribeOne on a single job, then delete it server-side. What does the client see?',
  },
  {
    href: '/scenarios/filter-boundary',
    title: 'A row entering and leaving a filter',
    blurb: 'Subscribe to { status: "RUNNING" } and flip a row in and out of that status.',
  },
  {
    href: '/scenarios/rls-isolation',
    title: 'RLS isolation across identities',
    blurb: "Switch identity with $setAuth and prove a write to one org never reaches the other's view.",
  },
  {
    href: '/scenarios/reconnect',
    title: 'Reconnect rebuilds the cache',
    blurb: 'Force a disconnect, write while offline, reconnect — there is no resumption, only a fresh snapshot.',
  },
  {
    href: '/scenarios/omitted-columns',
    title: 'Omitted columns never arrive',
    blurb: 'A policy-omitted field is absent from every payload, not merely hidden in the UI.',
  },
  {
    href: '/scenarios/sorted-window',
    title: '(Not supported) Sorted top-N live window',
    blurb: 'Why "watch the top 10 by priority" cannot be built on subscribeMany today.',
  },
];

export default function ScenariosIndex() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: '46rem' }}>
      <p>
        <Link href="/">← Home</Link>
      </p>
      <h1>Live-query scenarios</h1>
      <p style={{ color: '#444' }}>
        Each page runs a small server-driven simulation and logs what the live client actually
        received — not just the end state, but the delta, when it arrived, and what the cache
        looks like after.
      </p>
      <ul style={{ padding: 0, listStyle: 'none' }}>
        {SCENARIOS.map((s) => (
          <li
            key={s.href}
            style={{ border: '1px solid #ddd', borderRadius: 6, padding: '0.9rem 1rem', marginBottom: '0.7rem' }}
          >
            <Link href={s.href} style={{ fontWeight: 600, fontSize: '1.05rem' }}>
              {s.title}
            </Link>
            <p style={{ margin: '0.3rem 0 0', color: '#555' }}>{s.blurb}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}
