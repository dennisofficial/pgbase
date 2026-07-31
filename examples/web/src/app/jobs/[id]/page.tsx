'use client';

import { useLiveQuery } from '@dltech/pgbase/react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { write } from '../../../lib/api';
import { pgbase, type JobStatus, type Task } from '../../../pgbase/client';

const NEXT_STATUS: readonly { status: JobStatus; label: string }[] = [
  { status: 'QUEUED', label: 'Requeue' },
  { status: 'RUNNING', label: 'Start' },
  { status: 'DONE', label: 'Complete' },
  { status: 'FAILED', label: 'Fail' },
];

export default function JobPage() {
  const id = String(useParams().id);
  const [newTask, setNewTask] = useState('');
  const [error, setError] = useState<string | null>(null);

  const run = (work: Promise<unknown>) => {
    setError(null);
    work.catch((err: Error) => setError(err.message));
  };

  // A one-row subscription. Delete this job in another window and `job` becomes undefined here,
  // because the removal arrives as a delta — there is nothing to poll and nothing to invalidate.
  const [job] = useLiveQuery(pgbase.Job, { where: { id } });

  const open = useLiveQuery(pgbase.Task, { where: { jobId: id, done: false } });
  const completed = useLiveQuery(pgbase.Task, { where: { jobId: id, done: true } });

  // An empty snapshot and a not-yet-delivered one look the same to a subscriber, so hold the
  // verdict until the socket has had a moment. Nothing here is server-rendered either way.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setSettled(false);
    const timer = setTimeout(() => setSettled(true), 750);
    return () => clearTimeout(timer);
  }, [id]);

  if (job === undefined) {
    return (
      <main>
        <p>
          <Link href="/">← Board</Link>
        </p>
        {!settled ? (
          <p className="empty">Loading…</p>
        ) : (
          <>
            <h1>Not available</h1>
            <p className="lede">
              This job has been deleted, or it belongs to an org the signed-in user is not a member
              of. Both cases look identical from here on purpose: a client that could tell them
              apart could probe for row ids it is not allowed to read.
            </p>
          </>
        )}
      </main>
    );
  }

  return (
    <main>
      <p>
        <Link href="/">← Board</Link>
      </p>
      <h1>{job.name}</h1>
      <p className="lede">
        <span className="label">{job.status}</span> <span className="label">p{job.priority}</span>{' '}
        {job.labels.map((label) => (
          <span key={label} className="label">
            {label}
          </span>
        ))}
        {job.closedAt !== null && <> · closed {job.closedAt.toLocaleString()}</>}
      </p>

      {error !== null && <div className="error">{error}</div>}

      <div className="row" style={{ marginBottom: '1.4rem' }}>
        {NEXT_STATUS.filter((s) => s.status !== job.status).map((s) => (
          <button
            key={s.status}
            onClick={() => run(write(`/jobs/${job.id}/status`, 'PATCH', { status: s.status }))}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="panels">
        <section className="panel">
          <h2>
            Open — <code>{'{ done: false }'}</code>
          </h2>
          <Checklist tasks={open} run={run} />
          <form
            className="row"
            style={{ marginTop: '0.6rem' }}
            onSubmit={(e) => {
              e.preventDefault();
              if (newTask.trim() === '') return;
              run(
                write('/tasks', 'POST', { jobId: job.id, title: newTask }).then(() =>
                  setNewTask(''),
                ),
              );
            }}
          >
            <input
              value={newTask}
              placeholder="Add a checklist item"
              onChange={(e) => setNewTask(e.target.value)}
              style={{ flex: 1 }}
            />
            <button type="submit">Add</button>
          </form>
        </section>

        <section className="panel">
          <h2>
            Completed — <code>{'{ done: true }'}</code>
          </h2>
          <Checklist tasks={completed} run={run} />
        </section>
      </div>

      <p className="lede" style={{ marginTop: '1.4rem' }}>
        The two lists above are separate subscriptions over the same table. Ticking a box writes one
        boolean; the row then fails one filter and matches the other, so it is removed from the left
        list and inserted into the right one.
      </p>
    </main>
  );
}

function Checklist({
  tasks,
  run,
}: {
  readonly tasks: readonly Task[];
  readonly run: (work: Promise<unknown>) => void;
}) {
  const ordered = useMemo(
    () => [...tasks].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    [tasks],
  );

  if (ordered.length === 0) return <p className="empty">Nothing here.</p>;

  return (
    <ul className="checklist">
      {ordered.map((task) => (
        <li key={task.id} className={task.done ? 'done' : undefined}>
          <input
            type="checkbox"
            checked={task.done}
            onChange={(e) =>
              run(write(`/tasks/${task.id}/done`, 'PATCH', { done: e.target.checked }))
            }
          />
          <span className="text">{task.title}</span>
          <button
            className="link"
            style={{ marginLeft: 'auto' }}
            onClick={() => run(write(`/tasks/${task.id}`, 'DELETE'))}
          >
            Remove
          </button>
        </li>
      ))}
    </ul>
  );
}
