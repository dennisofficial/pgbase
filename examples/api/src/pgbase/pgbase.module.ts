import { PgbaseModule } from '@dltech/pgbase/nest';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvConfig } from '../config/env.config';
import pgbaseSchema from '../generated/pgbase/index';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { Caller } from './caller';
import { ClaimsModule, OrgMembershipClaimsBuilder } from './claims';
import { getPrincipal } from './dev-principal';
import { pgbasePolicies } from './policies';
import { ScopedDb } from './scoped-db';

@Module({
  imports: [
    PrismaModule,
    ClaimsModule,
    PgbaseModule.forRootAsync({
      imports: [PrismaModule, ClaimsModule],
      inject: [PrismaService, OrgMembershipClaimsBuilder, ConfigService],
      useFactory: (
        prisma: PrismaService,
        claimsBuilder: OrgMembershipClaimsBuilder,
        config: ConfigService<EnvConfig, true>,
      ) => ({
        // pgbase reads pg_catalog over a plain pool, separate from Prisma's. Handing it the URL
        // rather than a Pool means it also closes that pool on shutdown.
        connectionString: config.get('DATABASE_URL', { infer: true }),
        prisma,
        schema: pgbaseSchema,
        policies: pgbasePolicies,
        claimsBuilder,
        getPrincipal,
        // Top level, not inside `live`: the schema resolver reads it too, and two knobs can
        // disagree. A resolver pointed at a publication that does not exist quietly stops
        // enforcing the REPLICA IDENTITY FULL guard.
        publication: config.get('PGBASE_PUBLICATION', { infer: true }),
        // No `replicationConfig`: it defaults to `connectionString`, which is correct here because
        // this connects straight to Postgres. Behind a transaction pooler it would have to be set.
        live: {
          slotName: config.get('PGBASE_SLOT', { infer: true }),
          socketIoOptions: { cors: { origin: config.get('WEB_ORIGIN', { infer: true }) } },
        },
      }),
      scopedPrisma: ScopedDb,
    }),
  ],
  providers: [Caller],
  exports: [PgbaseModule, Caller],
})
export class AppPgbaseModule {}
