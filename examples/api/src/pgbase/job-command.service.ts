import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { requireContext, type ContextStore } from '@workspace/pgbase/context';
import { PGBASE_CONTEXT_STORE } from '@workspace/pgbase/nest';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Claims } from './claims.js';

@Injectable()
export class JobCommandService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PGBASE_CONTEXT_STORE) private readonly contextStore: ContextStore<string, Claims>,
  ) {}

  async bumpPriority(jobId: string): Promise<{ id: string; priority: number }> {
    const { claims } = requireContext(this.contextStore);

    const job = await this.prisma.job.findUnique({
      where: { id: jobId },
      select: { id: true, orgId: true, priority: true },
    });
    if (!job) throw new NotFoundException(`No job ${jobId}.`);
    // The read path gets this from the policy; a command states it itself.
    if (!claims.orgIds.includes(job.orgId)) {
      throw new ForbiddenException(`Job ${jobId} belongs to another org.`);
    }

    const updated = await this.prisma.job.update({
      where: { id: jobId },
      data: { priority: job.priority + 1 },
      select: { id: true, priority: true },
    });
    return updated;
  }
}
