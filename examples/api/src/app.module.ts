import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.config';
import { HealthModule } from './health/health.module';
import { JobsModule } from './jobs/jobs.module';
import { MeModule } from './me/me.module';
import { AppPgbaseModule } from './pgbase/pgbase.module';
import { TasksModule } from './tasks/tasks.module';

/**
 * `AppPgbaseModule` is the only import below that is pgbase-specific — everything else is an
 * ordinary Nest feature module. See `src/pgbase/pgbase.module.ts` for what installing pgbase costs.
 *
 * `ActivityModule` is absent on purpose: it serves no routes, and Jobs and Tasks each import it.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: '.env',
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    AppPgbaseModule,
    HealthModule,
    MeModule,
    JobsModule,
    TasksModule,
  ],
})
export class AppModule {}
