import { Controller, Get } from '@nestjs/common';
import { JobSummaryService } from './pgbase/job-summary.service';

@Controller()
export class AppController {
  constructor(private readonly jobSummary: JobSummaryService) {}

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  /** Demonstrates ScopedPrisma: an RLS-scoped read run server-side on behalf of the caller. */
  @Get('jobs/high-priority-count')
  highPriorityJobCount() {
    return this.jobSummary.highPriorityJobCount();
  }
}
