import { Injectable } from '@nestjs/common';
import { ActivityService } from '../activity/activity.service';
import type { TaskModel } from '../generated/prisma/models';
import { Caller } from '../pgbase/caller';
import { ScopedDb } from '../pgbase/scoped-db';

@Injectable()
export class TasksService {
  constructor(
    private readonly db: ScopedDb,
    private readonly caller: Caller,
    private readonly activity: ActivityService,
  ) {}

  async create(jobId: string, title: string): Promise<TaskModel> {
    // Denormalised `orgId` is what lets Task carry its own RLS predicate instead of joining to
    // Job for every row the live matcher has to test.
    const task = await this.db.task.create({
      data: { orgId: this.caller.orgId, jobId, title },
    });
    await this.activity.record(`added checklist item "${title}"`);
    return task;
  }

  // A task this caller cannot see raises ScopedRowNotFoundError; ScopedRowNotFoundFilter maps it
  // to a 404, so neither method below has to distinguish "gone" from "not yours".
  async setDone(id: string, done: boolean): Promise<TaskModel> {
    const task = await this.db.task.update({ where: { id }, data: { done } });
    await this.activity.record(`${done ? 'checked off' : 'reopened'} "${task.title}"`);
    return task;
  }

  async remove(id: string): Promise<void> {
    const task = await this.db.task.delete({ where: { id } });
    await this.activity.record(`removed checklist item "${task.title}"`);
  }
}
