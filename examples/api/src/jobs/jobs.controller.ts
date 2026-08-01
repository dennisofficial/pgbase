import { Body, Controller, Delete, Param, Patch, Post } from '@nestjs/common';
import { IdParamDto } from '../common/dto/id-param.dto';
import { AdjustPriorityDto } from './dto/adjust-priority.dto';
import { CreateJobDto } from './dto/create-job.dto';
import { RenameJobDto } from './dto/rename-job.dto';
import { SetJobStatusDto } from './dto/set-job-status.dto';
import { ToggleLabelDto } from './dto/toggle-label.dto';
import { JobsService } from './jobs.service';

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Post()
  create(@Body() dto: CreateJobDto) {
    return this.jobs.create(dto.name);
  }

  @Patch(':id/name')
  rename(@Param() { id }: IdParamDto, @Body() dto: RenameJobDto) {
    return this.jobs.rename(id, dto.name);
  }

  @Patch(':id/status')
  setStatus(@Param() { id }: IdParamDto, @Body() dto: SetJobStatusDto) {
    return this.jobs.setStatus(id, dto.status);
  }

  @Patch(':id/priority')
  adjustPriority(@Param() { id }: IdParamDto, @Body() dto: AdjustPriorityDto) {
    return this.jobs.adjustPriority(id, dto.delta);
  }

  @Patch(':id/labels')
  toggleLabel(@Param() { id }: IdParamDto, @Body() dto: ToggleLabelDto) {
    return this.jobs.toggleLabel(id, dto.label);
  }

  @Delete(':id')
  remove(@Param() { id }: IdParamDto) {
    return this.jobs.remove(id);
  }
}
