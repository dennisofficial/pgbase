import { Body, Controller, Delete, Param, Patch, Post } from '@nestjs/common';
import { IdParamDto } from '../common/dto/id-param.dto';
import { CreateTaskDto } from './dto/create-task.dto';
import { SetTaskDoneDto } from './dto/set-task-done.dto';
import { TasksService } from './tasks.service';

@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Post()
  create(@Body() dto: CreateTaskDto) {
    return this.tasks.create(dto.jobId, dto.title);
  }

  @Patch(':id/done')
  setDone(@Param() { id }: IdParamDto, @Body() dto: SetTaskDoneDto) {
    return this.tasks.setDone(id, dto.done);
  }

  @Delete(':id')
  remove(@Param() { id }: IdParamDto) {
    return this.tasks.remove(id);
  }
}
