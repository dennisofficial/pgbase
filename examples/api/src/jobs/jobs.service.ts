import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ActivityService } from '../activity/activity.service';
import type { Prisma } from '../generated/prisma/client';
import { JobStatus } from '../generated/prisma/enums';
import type { JobModel } from '../generated/prisma/models';
import { Caller } from '../pgbase/caller';
import { ScopedDb } from '../pgbase/scoped-db';

const TERMINAL: readonly JobStatus[] = [JobStatus.DONE, JobStatus.FAILED];

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

@Injectable()
export class JobsService {
  constructor(
    private readonly db: ScopedDb,
    private readonly caller: Caller,
    private readonly activity: ActivityService,
  ) {}

  async create(name: string): Promise<JobModel> {
    const job = await this.db.job.create({
      data: { orgId: this.caller.orgId, name, status: JobStatus.QUEUED },
    });
    await this.activity.record(`created job "${name}"`);
    return job;
  }

  async rename(id: string, name: string): Promise<JobModel> {
    const job = await this.update(id, { name });
    await this.activity.record(`renamed a job to "${name}"`);
    return job;
  }

  async setStatus(id: string, status: JobStatus): Promise<JobModel> {
    const job = await this.update(id, {
      status,
      closedAt: TERMINAL.includes(status) ? new Date() : null,
    });
    await this.activity.record(`moved "${job.name}" to ${status}`);
    return job;
  }

  async adjustPriority(id: string, delta: number): Promise<JobModel> {
    const job = await this.update(id, { priority: { increment: delta } });
    await this.activity.record(`set "${job.name}" to priority ${job.priority}`);
    return job;
  }

  async toggleLabel(id: string, label: string): Promise<JobModel> {
    const current = await this.db.job.findUnique({ where: { id } });
    if (!current) throw new NotFoundException(`No job ${id} visible to this user.`);

    const had = current.labels.includes(label);
    const job = await this.update(id, {
      labels: had ? current.labels.filter((l) => l !== label) : [...current.labels, label],
    });
    await this.activity.record(`${had ? 'removed' : 'added'} label "${label}" on "${job.name}"`);
    return job;
  }

  async remove(id: string): Promise<void> {
    const job = await this.db.job.delete({ where: { id } });
    await this.activity.record(`deleted job "${job.name}"`);
  }

  private async update(id: string, data: Prisma.JobUpdateInput): Promise<JobModel> {
    try {
      return await this.db.job.update({ where: { id }, data });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('Another job in this org is already running.');
      }
      throw err;
    }
  }
}
