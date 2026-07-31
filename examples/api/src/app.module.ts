import { PgbaseModule } from '@dltech/pgbase/nest';
import { Module, UnauthorizedException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { Pool } from 'pg';
import { AppController } from './app.controller';
import pgbaseSchema from './generated/pgbase/index';
import { ClaimsModule, OrgMembershipClaimsBuilder, type Principal } from './pgbase/claims';
import { pgbasePolicies } from './pgbase/policies';
import { SCHEMA_POOL, SchemaPoolModule } from './pgbase/schema-pool.provider';
import { ScopedDb } from './pgbase/scoped-db';
import { PrismaModule } from './prisma/prisma.module';
import { PrismaService } from './prisma/prisma.service';
import { ActivityService } from './work/activity.service';
import { Caller } from './work/caller';
import { JobsController } from './work/jobs.controller';
import { JobsService } from './work/jobs.service';
import { TasksController } from './work/tasks.controller';
import { TasksService } from './work/tasks.service';

/**
 * DEV-ONLY principal selection: the caller names a seeded user by id in a header. There is no
 * session, token, or password anywhere in this example — swap this for real auth before this
 * code is anything but a harness.
 */
const DEV_USER_HEADER = 'x-pgbase-dev-user';

interface RequestLike {
  readonly headers?: Record<string, string | string[] | undefined>;
  /** socket.io's handshake carries this; an HTTP request does not. */
  readonly auth?: Record<string, unknown>;
}

/**
 * Reads the caller from a header OR socket.io's handshake `auth` payload, because a browser cannot
 * send custom headers on a WebSocket handshake — the WebSocket API has no way to set them, so
 * `extraHeaders` is silently dropped there. Anything that must work from a browser socket has to
 * travel in `auth`. Real token auth will hit exactly the same constraint.
 */
function getPrincipal(req: unknown): Principal {
  const like = req as RequestLike;
  const header = like.headers?.[DEV_USER_HEADER];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  const fromAuth = like.auth?.[DEV_USER_HEADER];
  const userId = fromHeader ?? (typeof fromAuth === 'string' ? fromAuth : undefined);
  if (!userId) {
    throw new UnauthorizedException(
      `Missing "${DEV_USER_HEADER}" (dev-only stand-in for auth). Send it as a header over HTTP, ` +
        `or in socket.io's "auth" payload over a socket — a browser WebSocket cannot send headers.`,
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
        live: {
          replicationConfig: { connectionString: process.env.DATABASE_URL },
          slotName: process.env.PGBASE_SLOT ?? 'pgbase_example',
          publication: 'pgbase',
          socketIoOptions: { cors: { origin: 'http://localhost:3000' } },
        },
      }),
      scopedPrisma: ScopedDb,
    }),
  ],
  controllers: [AppController, JobsController, TasksController],
  providers: [Caller, ActivityService, JobsService, TasksService],
})
export class AppModule {}
