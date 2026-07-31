import type { INestApplication } from '@nestjs/common';

/**
 * Shared by `main.ts` and the e2e suite, so the tests exercise the same CORS and shutdown wiring
 * the dev server runs under rather than a second, drifting copy.
 */
export function configureApp(app: INestApplication): void {
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    allowedHeaders: ['content-type', 'x-pgbase-dev-user'],
  });
  app.enableShutdownHooks();
}
