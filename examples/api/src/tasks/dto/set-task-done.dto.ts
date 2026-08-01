import { IsBoolean } from 'class-validator';

export class SetTaskDoneDto {
  @IsBoolean()
  done!: boolean;
}
