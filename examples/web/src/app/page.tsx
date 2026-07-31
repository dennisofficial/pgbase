'use client';

import { useLiveQuery } from '@dltech/pgbase/react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { write } from '../lib/api';
import { pgbase, type Job, type JobStatus, type Task } from '../pgbase/client';

const COLUMNS: readonly { status: JobStatus; title: string }[] = [
  { status: 'QUEUED', title: 'Backlog' },
  { status: 'RUNNING', title: 'Running' },
  { status: 'DONE', title: 'Done' },
  { status: 'FAILED', title: 'Failed' },
];

const MOVE_LABEL: Record<JobStatus, string> = {
  QUEUED: 'Requeue',
  RUNNING: 'Start',
  DONE: 'Complete',
  FAILED: 'Fail',
};

export default function BoardPage() {
  const [urgentOnly, setUrgentOnly] = useState(false);
  const [newJob, setNewJob] = useState('');
  const [error, setError] = useState<string | null>(null);

  const run = (work: Promise<unknown>) => {
    setError(null);
    work.catch((err: Error) => setError(err.message));
  };

  // One subscription covering every visible checklist item, joined to its job in the browser. Two
  // live queries stay consistent with each other because both are fed by the same WAL stream.
  const tasks = useLiveQuery(pgbase.Task);
  const progress = useMemo(() => summarise(tasks), [tasks]);

  return (
    <main>
      <h1>Board</h1>
      <p className="lede">
        Each column is its own live subscription filtered by <code>status</code>. Move a job and it
        leaves one subscription and enters another — here and in every other open window, without
        either of them asking the server for a new list.
      </p>

      {error !== null && <div className="error">{error}</div>}

      <div className="row" style={{ marginBottom: '1rem' }}>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (newJob.trim() === '') return;
            run(write('/jobs', 'POST', { name: newJob }).then(() => setNewJob('')));
          }}
        >
          <input
            value={newJob}
            placeholder="New job name"
            onChange={(e) => setNewJob(e.target.value)}
            style={{ width: '15rem' }}
          />
          <button className="primary" type="submit">
            Add
          </button>
        </form>
        <label className="row" style={{ marginLeft: 'auto' }}>
          <input
            type="checkbox"
            checked={urgentOnly}
            onChange={(e) => setUrgentOnly(e.target.checked)}
          />
          Only <code>{'labels: { has: "urgent" }'}</code>
        </label>
      </div>

      <div className="board">
        {COLUMNS.map((column) => (
          <Column
            key={column.status}
            status={column.status}
            title={column.title}
            urgentOnly={urgentOnly}
            progress={progress}
            run={run}
          />
        ))}
      </div>
    </main>
  );
}

function Column({
  status,
  title,
  urgentOnly,
  progress,
  run,
}: {
  readonly status: JobStatus;
  readonly title: string;
  readonly urgentOnly: boolean;
  readonly progress: ReadonlyMap<string, { done: number; total: number }>;
  readonly run: (work: Promise<unknown>) => void;
}) {
  // Toggling the filter re-subscribes with a different `where`, so the column redraws from a new
  // server snapshot rather than filtering rows it already holds.
  const jobs = useLiveQuery(pgbase.Job, {
    where: urgentOnly ? { status, labels: { has: 'urgent' } } : { status },
  });

  // Live results arrive as a keyed set, not an ordered list — ordering is the caller's to decide.
  const ordered = useMemo(
    () => [...jobs].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name)),
    [jobs],
  );

  return (
    <section className="column">
      <h2>
        <span>{title}</span>
        <span>{ordered.length}</span>
      </h2>
      {ordered.length === 0 && <p className="empty">Nothing here.</p>}
      {ordered.map((job) => (
        <JobCard key={job.id} job={job} progress={progress.get(job.id)} run={run} />
      ))}
    </section>
  );
}

function JobCard({
  job,
  progress,
  run,
}: {
  readonly job: Job;
  readonly progress?: { done: number; total: number };
  readonly run: (work: Promise<unknown>) => void;
}) {
  return (
    <article className="card">
      <div className="title">
        <Link href={`/jobs/${job.id}`}>{job.name}</Link>
      </div>
      <div className="row" style={{ marginBottom: '0.35rem' }}>
        <span className="label">p{job.priority}</span>
        {job.labels.map((label) => (
          <span key={label} className="label">
            {label}
          </span>
        ))}
        {progress !== undefined && (
          <span className="label">
            {progress.done}/{progress.total} done
          </span>
        )}
      </div>
      <div className="row actions">
        {COLUMNS.filter((c) => c.status !== job.status).map((c) => (
          <button
            key={c.status}
            onClick={() => run(write(`/jobs/${job.id}/status`, 'PATCH', { status: c.status }))}
          >
            {MOVE_LABEL[c.status]}
          </button>
        ))}
        <button onClick={() => run(write(`/jobs/${job.id}/priority`, 'PATCH', { delta: 1 }))}>
          +1
        </button>
        <button onClick={() => run(write(`/jobs/${job.id}/labels`, 'PATCH', { label: 'urgent' }))}>
          {job.labels.includes('urgent') ? 'Un-urgent' : 'Urgent'}
        </button>
        <button
          className="link"
          style={{ marginLeft: 'auto' }}
          onClick={() => run(write(`/jobs/${job.id}`, 'DELETE'))}
        >
          Delete
        </button>
      </div>
    </article>
  );
}

function summarise(tasks: readonly Task[]): ReadonlyMap<string, { done: number; total: number }> {
  const byJob = new Map<string, { done: number; total: number }>();
  for (const task of tasks) {
    const entry = byJob.get(task.jobId) ?? { done: 0, total: 0 };
    entry.total += 1;
    if (task.done) entry.done += 1;
    byJob.set(task.jobId, entry);
  }
  return byJob;
}
