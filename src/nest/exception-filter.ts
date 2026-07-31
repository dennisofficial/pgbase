import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { ScopeViolationError } from '../context/index.js';
import { ReadValidationError } from '../read/index.js';

@Catch(ReadValidationError, ScopeViolationError)
export class PgbaseExceptionFilter implements ExceptionFilter {
  catch(err: ReadValidationError | ScopeViolationError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse();
    const status = err instanceof ScopeViolationError ? 403 : 400;
    res.status(status).json({ statusCode: status, error: err.name, message: err.message });
  }
}
