import { NestFactory } from '@nestjs/core';
import 'reflect-metadata';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';

try {
  process.loadEnvFile();
} catch {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    forceCloseConnections: true,
  });
  configureApp(app);
  await app.listen(process.env.PORT ?? 3001);
}

void bootstrap();
