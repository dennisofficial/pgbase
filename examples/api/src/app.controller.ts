import { Controller, Get, Param, Post } from '@nestjs/common';
import { JobCommandService } from './pgbase/job-command.service';
import { JobSummaryService } from './pgbase/job-summary.service';

@Controller()
export class AppController {
  constructor(
    private readonly jobSummary: JobSummaryService,
    private readonly jobCommands: JobCommandService,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  /** Demonstrates ScopedPrisma: an RLS-scoped read run server-side on behalf of the caller. */
  @Get('jobs/high-priority-count')
  highPriorityJobCount() {
    return this.jobSummary.highPriorityJobCount();
  }

  /** Writes nothing to any socket — the WAL carries this update to live subscribers on its own. */
  @Post('jobs/:id/bump-priority')
  bumpPriority(@Param('id') id: string) {
    return this.jobCommands.bumpPriority(id);
  }
}
