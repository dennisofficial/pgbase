import { BadRequestException, Body, Controller, Delete, Param, Patch, Post } from '@nestjs/common';
import { TasksService } from './tasks.service';

@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Post()
  create(@Body('jobId') jobId: string, @Body('title') title: string) {
    if (typeof jobId !== 'string' || jobId === '') {
      throw new BadRequestException('"jobId" must be a job id.');
    }
    if (typeof title !== 'string' || title.trim() === '') {
      throw new BadRequestException('"title" must be a non-empty string.');
    }
    return this.tasks.create(jobId, title.trim());
  }

  @Patch(':id/done')
  setDone(@Param('id') id: string, @Body('done') done: boolean) {
    if (typeof done !== 'boolean') throw new BadRequestException('"done" must be a boolean.');
    return this.tasks.setDone(id, done);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.tasks.remove(id);
  }
}
