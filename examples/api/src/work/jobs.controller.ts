import { BadRequestException, Body, Controller, Delete, Param, Patch, Post } from '@nestjs/common';
import { JobStatus } from '../generated/prisma/enums';
import { JobsService } from './jobs.service';

/**
 * Writes only. Nothing here returns a list, and nothing here publishes to a socket: the browser
 * reads jobs through pgbase's own live subscriptions, and the WAL carries every row below to every
 * subscriber whose filter still matches it.
 */
@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Post()
  create(@Body('name') name: string) {
    return this.jobs.create(requireText(name, 'name'));
  }

  @Patch(':id/name')
  rename(@Param('id') id: string, @Body('name') name: string) {
    return this.jobs.rename(id, requireText(name, 'name'));
  }

  @Patch(':id/status')
  setStatus(@Param('id') id: string, @Body('status') status: string) {
    if (!(status in JobStatus)) {
      throw new BadRequestException(
        `"${status}" is not a job status. Expected one of: ${Object.keys(JobStatus).join(', ')}.`,
      );
    }
    return this.jobs.setStatus(id, status as JobStatus);
  }

  @Patch(':id/priority')
  adjustPriority(@Param('id') id: string, @Body('delta') delta: number) {
    if (!Number.isInteger(delta)) throw new BadRequestException('"delta" must be an integer.');
    return this.jobs.adjustPriority(id, delta);
  }

  @Patch(':id/labels')
  toggleLabel(@Param('id') id: string, @Body('label') label: string) {
    return this.jobs.toggleLabel(id, requireText(label, 'label'));
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.jobs.remove(id);
  }
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestException(`"${field}" must be a non-empty string.`);
  }
  return value.trim();
}
