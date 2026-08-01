import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { Trim } from '../../common/trim.decorator';

export class CreateJobDto {
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;
}
