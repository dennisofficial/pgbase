import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';
import { Trim } from '../../common/trim.decorator';

export class CreateTaskDto {
  @IsUUID()
  jobId!: string;

  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;
}
