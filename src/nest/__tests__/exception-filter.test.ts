import { describe, expect, it } from 'vitest';
import { ScopeViolationError } from '../../context/index.js';
import { ReadValidationError } from '../../read/index.js';
import { PgbaseExceptionFilter } from '../exception-filter.js';
import { ScopedRowNotFoundError } from '../scoped-errors.js';

interface Captured {
  status: number;
  body: unknown;
}

function catchOne(err: Error): Captured {
  const captured: Captured = { status: 0, body: undefined };
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
    },
  };
  const host = { switchToHttp: () => ({ getResponse: () => res }) };
  new PgbaseExceptionFilter().catch(err as never, host as never);
  return captured;
}

describe('PgbaseExceptionFilter', () => {
  it('maps a read validation failure to 400', () => {
    const { status, body } = catchOne(new ReadValidationError('Job', 'where', 'nope'));
    expect(status).toBe(400);
    expect(body).toMatchObject({ statusCode: 400, error: 'ReadValidationError' });
  });

  it('maps a scope violation to 403', () => {
    const { status, body } = catchOne(new ScopeViolationError('Job', 'update', 'nope'));
    expect(status).toBe(403);
    expect(body).toMatchObject({ statusCode: 403, error: 'ScopeViolationError' });
  });

  // 404 rather than 403: a 403 here would confirm the row exists, which is the disclosure the
  // error exists to prevent.
  it('maps an invisible row to 404, indistinguishable from a row that does not exist', () => {
    const { status, body } = catchOne(new ScopedRowNotFoundError('Job'));
    expect(status).toBe(404);
    expect(body).toMatchObject({ statusCode: 404, error: 'ScopedRowNotFoundError' });
  });
});
