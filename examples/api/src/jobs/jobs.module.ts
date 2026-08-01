import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module';
import { AppPgbaseModule } from '../pgbase/pgbase.module';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';

@Module({
  imports: [AppPgbaseModule, ActivityModule],
  controllers: [JobsController],
  providers: [JobsService],
})
export class JobsModule {}
