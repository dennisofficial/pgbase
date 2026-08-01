import { Module } from '@nestjs/common';
import { AppPgbaseModule } from '../pgbase/pgbase.module';
import { MeController } from './me.controller';

@Module({
  imports: [AppPgbaseModule],
  controllers: [MeController],
})
export class MeModule {}
