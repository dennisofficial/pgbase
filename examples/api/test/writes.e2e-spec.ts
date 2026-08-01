import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';

const ALICE = '00000000-0000-4000-8000-0000000000a1';
/** Well-formed and deliberately not seeded. Nothing below relies on the seed's mutable state. */
const ABSENT = '00000000-0000-4000-8000-0000000f0000';

let app: INestApplication;
let url: string;

function send(path: string, method: string, body?: unknown): Promise<Response> {
  return fetch(`${url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-pgbase-dev-user': ALICE },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  configureApp(app);
  await app.listen(0);
  url = (await app.getUrl()).replace('[::1]', 'localhost');
}, 90_000);

afterAll(async () => {
  await app?.close();
});

describe('request validation', () => {
  it('rejects a blank name, after trimming it', async () => {
    const res = await send('/jobs', 'POST', { name: '   ' });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain('name should not be empty');
  });

  it('rejects a body carrying a property no DTO declares', async () => {
    const res = await send('/jobs', 'POST', { name: 'ok', orgId: 'someone-elses-org' });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed id before it ever reaches the database', async () => {
    const res = await send('/jobs/not-a-uuid/priority', 'PATCH', { delta: 1 });
    expect(res.status).toBe(400);
  });

  it('rejects a status outside the enum, naming the ones that exist', async () => {
    const res = await send(`/jobs/${ABSENT}/status`, 'PATCH', { status: 'SIDEWAYS' });
    expect(res.status).toBe(400);
    expect(JSON.stringify((await res.json()).message)).toMatch(/QUEUED/);
  });

  it('trims a valid name rather than storing the whitespace', async () => {
    const created = await send('/jobs', 'POST', { name: '  scratch job  ' });
    expect(created.status).toBe(201);
    const job = await created.json();
    expect(job.name).toBe('scratch job');
    expect((await send(`/jobs/${job.id}`, 'DELETE')).ok).toBe(true);
  });
});

describe('errors the app surfaces rather than hides', () => {
  it('turns a write against an invisible row into a 404, not a silent no-op', async () => {
    const res = await send(`/jobs/${ABSENT}`, 'DELETE');
    expect(res.status).toBe(404);
    expect((await res.json()).message).toMatch(/visible to this caller/i);
  });

  it('reports the partial unique index as a 409 naming the actual rule', async () => {
    const a = await (await send('/jobs', 'POST', { name: 'conflict probe a' })).json();
    const b = await (await send('/jobs', 'POST', { name: 'conflict probe b' })).json();
    try {
      // Two jobs of our own, so this never depends on whatever the org happens to be running:
      // if something already is, the first attempt conflicts; if not, the second one does.
      const first = await send(`/jobs/${a.id}/status`, 'PATCH', { status: 'RUNNING' });
      const blocked =
        first.status === 409
          ? first
          : await send(`/jobs/${b.id}/status`, 'PATCH', { status: 'RUNNING' });

      expect(blocked.status).toBe(409);
      expect((await blocked.json()).message).toMatch(/already running/i);
    } finally {
      await send(`/jobs/${a.id}`, 'DELETE');
      await send(`/jobs/${b.id}`, 'DELETE');
    }
  });
});
