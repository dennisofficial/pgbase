import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import 'reflect-metadata';
import { AppModule } from './app.module';
import type { EnvConfig } from './config/env.config';
import { configureApp } from './configure-app';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { forceCloseConnections: true });
  configureApp(app);
  await app.listen(
    app.get<ConfigService<EnvConfig, true>>(ConfigService).get('PORT', { infer: true }),
  );
}

void bootstrap();
