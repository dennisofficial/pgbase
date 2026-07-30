import { NestFactory } from '@nestjs/core';
import 'reflect-metadata';
import { AppModule } from './app.module';

try {
  process.loadEnvFile();
} catch {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3001);
}

void bootstrap();
