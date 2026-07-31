import { ScopedRowNotFoundError } from '@dltech/pgbase/nest';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { TaskModel } from '../generated/prisma/models';
import { ScopedDb } from '../pgbase/scoped-db';
import { ActivityService } from './activity.service';
import { Caller } from './caller';

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

  async setDone(id: string, done: boolean): Promise<TaskModel> {
    const task = await this.db.task.update({ where: { id }, data: { done } }).catch(notFound(id));
    await this.activity.record(`${done ? 'checked off' : 'reopened'} "${task.title}"`);
    return task;
  }

  async remove(id: string): Promise<void> {
    const task = await this.db.task.delete({ where: { id } }).catch(notFound(id));
    await this.activity.record(`removed checklist item "${task.title}"`);
  }
}

function notFound(id: string): (err: unknown) => never {
  return (err) => {
    if (err instanceof ScopedRowNotFoundError) {
      throw new NotFoundException(`No task ${id} visible to this user.`);
    }
    throw err;
  };
}
