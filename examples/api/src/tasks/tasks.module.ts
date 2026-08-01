import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module';
import { AppPgbaseModule } from '../pgbase/pgbase.module';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  imports: [AppPgbaseModule, ActivityModule],
  controllers: [TasksController],
  providers: [TasksService],
})
export class TasksModule {}
