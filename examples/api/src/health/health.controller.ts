import { Controller, Get } from '@nestjs/common';

/**
 * Note for anyone copying this: pgbase's context middleware is applied with `forRoutes('*')`, so
 * this endpoint answers `401` without a principal. It still proves the process is serving, but it
 * is not yet an anonymous liveness probe an orchestrator can poll.
 */
@Controller('health')
export class HealthController {
  @Get()
  check() {
    return { status: 'ok' };
  }
}
