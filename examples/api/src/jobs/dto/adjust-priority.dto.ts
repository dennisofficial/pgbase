import { IsInt } from 'class-validator';

export class AdjustPriorityDto {
  @IsInt()
  delta!: number;
}
