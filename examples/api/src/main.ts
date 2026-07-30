import { NestFactory } from '@nestjs/core';
import 'reflect-metadata';
import { AppModule } from './app.module';

// Same story as prisma.config.ts: nothing loads `.env` for us. Do it before AppModule is
// imported, so PrismaService sees DATABASE_URL when its constructor runs.
try {
  process.loadEnvFile();
} catch {
  // No .env file — expected in CI, where DATABASE_URL comes from the real environment.
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3001);
}

void bootstrap();
