import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { ScopeViolationError } from '../context/index.js';
import { ReadValidationError } from '../read/index.js';
import { ScopedRowNotFoundError } from './scoped-errors.js';

type Handled = ReadValidationError | ScopeViolationError | ScopedRowNotFoundError;

function statusOf(err: Handled): number {
  if (err instanceof ScopeViolationError) return 403;
  if (err instanceof ScopedRowNotFoundError) return 404;
  return 400;
}

@Catch(ReadValidationError, ScopeViolationError, ScopedRowNotFoundError)
export class PgbaseExceptionFilter implements ExceptionFilter {
  catch(err: Handled, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse();
    const status = statusOf(err);
    res.status(status).json({ statusCode: status, error: err.name, message: err.message });
  }
}
