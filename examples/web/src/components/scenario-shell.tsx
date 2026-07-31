'use client';

import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';

export function ScenarioShell({
  title,
  blurb,
  children,
}: {
  readonly title: string;
  readonly blurb: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: '46rem' }}>
      <p>
        <Link href="/scenarios">← All scenarios</Link>
      </p>
      <h1 style={{ marginBottom: '0.3rem' }}>{title}</h1>
      <p style={{ color: '#444' }}>{blurb}</p>
      {children}
    </main>
  );
}

export function runButtonStyle(running: boolean): CSSProperties {
  return {
    padding: '0.5rem 1rem',
    fontSize: '1rem',
    cursor: running ? 'default' : 'pointer',
    opacity: running ? 0.6 : 1,
  };
}
