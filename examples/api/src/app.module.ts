import { Module, UnauthorizedException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PgbaseModule } from '@workspace/pgbase/nest';
import type { Pool } from 'pg';
import { AppController } from './app.controller';
import pgbaseSchema from './generated/pgbase/index';
import { ClaimsModule, OrgMembershipClaimsBuilder, type Principal } from './pgbase/claims';
import { JobSummaryService } from './pgbase/job-summary.service';
import { pgbasePolicies } from './pgbase/policies';
import { SCHEMA_POOL, SchemaPoolModule } from './pgbase/schema-pool.provider';
import { ScopedDb } from './pgbase/scoped-db';
import { PrismaModule } from './prisma/prisma.module';
import { PrismaService } from './prisma/prisma.service';

/**
 * DEV-ONLY principal selection: the caller names a seeded user by id in a header. There is no
 * session, token, or password anywhere in this example — swap this for real auth before this
 * code is anything but a harness.
 */
const DEV_USER_HEADER = 'x-pgbase-dev-user';

interface RequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
}

function getPrincipal(req: unknown): Principal {
  const header = (req as RequestLike).headers[DEV_USER_HEADER];
  const userId = Array.isArray(header) ? header[0] : header;
  if (!userId) {
    throw new UnauthorizedException(
      `Missing "${DEV_USER_HEADER}" header (dev-only stand-in for auth) — set it to a seeded user id.`,
    );
  }
  return userId;
}

@Module({
  imports: [
    ConfigModule.forRoot({ envFilePath: '.env', isGlobal: true }),
    PrismaModule,
    SchemaPoolModule,
    ClaimsModule,
    PgbaseModule.forRootAsync({
      imports: [PrismaModule, SchemaPoolModule, ClaimsModule],
      inject: [PrismaService, SCHEMA_POOL, OrgMembershipClaimsBuilder],
      useFactory: (
        prisma: PrismaService,
        pool: Pool,
        claimsBuilder: OrgMembershipClaimsBuilder,
      ) => ({
        pool,
        prisma,
        schema: pgbaseSchema,
        policies: pgbasePolicies,
        claimsBuilder,
        getPrincipal,
      }),
      scopedPrisma: ScopedDb,
    }),
  ],
  controllers: [AppController],
  providers: [JobSummaryService],
})
export class AppModule {}
