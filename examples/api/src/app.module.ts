import { Module } from '@nestjs/common';
// The subpath is still a stub (`export {}`), so this is a namespace-only import — it exists to
// prove `@workspace/pgbase/nest` resolves through the workspace link at build time, ahead of the
// package having any real exports.
import * as PgbaseNest from '@workspace/pgbase/nest';
import { AppController } from './app.controller';
import { PrismaModule } from './prisma/prisma.module';

void PgbaseNest;

@Module({
  imports: [PrismaModule],
  controllers: [AppController],
})
export class AppModule {}
