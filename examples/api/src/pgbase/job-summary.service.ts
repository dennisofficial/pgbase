import { Injectable } from '@nestjs/common';
import { ScopedDb } from './scoped-db.js';

@Injectable()
export class JobSummaryService {
  constructor(private readonly db: ScopedDb) {}

  async highPriorityJobCount(): Promise<{ count: number }> {
    const highPriority = await this.db.job.findMany({ where: { priority: { gte: 1 } } });
    return { count: highPriority.length };
  }
}
