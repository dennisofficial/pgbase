import { IsEnum } from 'class-validator';
import { JobStatus } from '../../generated/prisma/enums';

export class SetJobStatusDto {
  @IsEnum(JobStatus)
  status!: JobStatus;
}
