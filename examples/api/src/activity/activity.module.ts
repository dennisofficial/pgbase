import { Module } from '@nestjs/common';
import { AppPgbaseModule } from '../pgbase/pgbase.module';
import { ActivityService } from './activity.service';

@Module({
  imports: [AppPgbaseModule],
  providers: [ActivityService],
  exports: [ActivityService],
})
export class ActivityModule {}
