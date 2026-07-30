import { Controller, Get } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';

@Controller()
export class AppController {
  constructor(private readonly prismaService: PrismaService) {}

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  /**
   * TEMPORARY — and it is the exact thing pgbase exists to delete.
   *
   * docs/DESIGN.md §1: "The backend writes NO read endpoints." Under CQS a client wanting jobs
   * subscribes through the SDK inside an RLS envelope it cannot influence; it does not call a
   * hand-written GET with no policy attached. This route has no authorization whatsoever, which
   * is precisely the failure mode the package is designed to make impossible.
   *
   * It exists for one reason: to prove the Prisma wiring end to end before any of pgbase is
   * implemented. **Phase 5 deletes it** — when the Tier 1 one-shot path lands, this is the
   * "before" side of the comparison and the first thing to go.
   *
   * What does NOT go away: mutation endpoints. CQS removes reads from the controller, not writes
   * — commands stay imperative NestJS services. This controller keeps existing; it just stops
   * having GETs that return rows.
   */
  @Get('jobs')
  jobs() {
    return this.prismaService.job.findMany({ take: 10 });
  }
}
