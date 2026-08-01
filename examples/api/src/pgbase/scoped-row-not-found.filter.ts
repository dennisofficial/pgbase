import { ScopedRowNotFoundError } from '@dltech/pgbase/nest';
import { Catch, HttpStatus, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';

@Catch(ScopedRowNotFoundError)
export class ScopedRowNotFoundFilter implements ExceptionFilter {
  catch(err: ScopedRowNotFoundError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse();
    res.status(HttpStatus.NOT_FOUND).json({
      statusCode: HttpStatus.NOT_FOUND,
      error: 'Not Found',
      message: err.message,
    });
  }
}
