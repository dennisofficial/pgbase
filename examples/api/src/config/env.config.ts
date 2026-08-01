import { plainToInstance, Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsString, Max, Min, validateSync } from 'class-validator';

export class EnvConfig {
  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65_535)
  PORT: number = 3001;

  @IsString()
  @IsNotEmpty()
  WEB_ORIGIN: string = 'http://localhost:3000';

  @IsString()
  @IsNotEmpty()
  PGBASE_SLOT: string = 'pgbase_example';

  @IsString()
  @IsNotEmpty()
  PGBASE_PUBLICATION: string = 'pgbase';
}

export function validateEnv(raw: Record<string, unknown>): EnvConfig {
  const config = plainToInstance(EnvConfig, raw);
  const errors = validateSync(config, { skipMissingProperties: false });
  if (errors.length > 0) {
    const detail = errors
      .map((e) => `  ${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`)
      .join('\n');
    throw new Error(
      `Invalid environment — copy examples/api/.env.example to examples/api/.env:\n${detail}`,
    );
  }
  return config;
}
