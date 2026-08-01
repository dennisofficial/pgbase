import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvConfig } from './config/env.config';
import { DEV_USER_HEADER } from './pgbase/dev-principal';

/**
 * Shared by `main.ts` and the e2e suite, so the tests exercise the same validation, CORS and
 * shutdown wiring the dev server runs under rather than a second, drifting copy.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get<ConfigService<EnvConfig, true>>(ConfigService);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableCors({
    origin: config.get('WEB_ORIGIN', { infer: true }),
    allowedHeaders: ['content-type', DEV_USER_HEADER],
  });
  app.enableShutdownHooks();
}
