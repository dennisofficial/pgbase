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
   * TEMPORARY — a hand-written read endpoint with no authorization, which is the exact failure
   * mode pgbase exists to make impossible. It is here only to prove the Prisma wiring end to end,
   * and is deleted once clients can query through the SDK.
   *
   * Mutation endpoints do not go away; only reads leave the controller.
   */
  @Get('jobs')
  jobs() {
    return this.prismaService.job.findMany({ take: 10 });
  }
}
