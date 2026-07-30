import { Controller, Get } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';

@Controller()
export class AppController {
  constructor(private readonly prismaService: PrismaService) {}

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Get('jobs')
  jobs() {
    return this.prismaService.job.findMany({ take: 10 });
  }
}
