import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ScopedDb } from './scoped-db.js';

@Injectable()
export class JobCommandService {
  constructor(
    private readonly db: ScopedDb,
    private readonly prisma: PrismaService,
  ) {}

  async bumpPriority(jobId: string): Promise<{ id: string; priority: number }> {
    const updated = await this.db.job.update({
      where: { id: jobId },
      data: { priority: { increment: 1 } },
    });
    return { id: updated.id, priority: updated.priority };
  }
}
