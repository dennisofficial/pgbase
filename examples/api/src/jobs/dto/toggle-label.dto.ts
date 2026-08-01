import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { Trim } from '../../common/trim.decorator';

export class ToggleLabelDto {
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  label!: string;
}
