import { PgbaseModule } from '@dltech/pgbase/nest';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import type { Pool } from 'pg';
import type { EnvConfig } from '../config/env.config';
import pgbaseSchema from '../generated/pgbase/index';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { Caller } from './caller';
import { ClaimsModule, OrgMembershipClaimsBuilder } from './claims';
import { getPrincipal } from './dev-principal';
import { pgbasePolicies } from './policies';
import { SCHEMA_POOL, SchemaPoolModule } from './schema-pool.provider';
import { ScopedDb } from './scoped-db';
import { ScopedRowNotFoundFilter } from './scoped-row-not-found.filter';

@Module({
  imports: [
    PrismaModule,
    SchemaPoolModule,
    ClaimsModule,
    PgbaseModule.forRootAsync({
      imports: [PrismaModule, SchemaPoolModule, ClaimsModule],
      inject: [PrismaService, SCHEMA_POOL, OrgMembershipClaimsBuilder, ConfigService],
      useFactory: (
        prisma: PrismaService,
        pool: Pool,
        claimsBuilder: OrgMembershipClaimsBuilder,
        config: ConfigService<EnvConfig, true>,
      ) => ({
        pool,
        prisma,
        schema: pgbaseSchema,
        policies: pgbasePolicies,
        claimsBuilder,
        getPrincipal,
        live: {
          replicationConfig: { connectionString: config.get('DATABASE_URL', { infer: true }) },
          slotName: config.get('PGBASE_SLOT', { infer: true }),
          publication: config.get('PGBASE_PUBLICATION', { infer: true }),
          socketIoOptions: { cors: { origin: config.get('WEB_ORIGIN', { infer: true }) } },
        },
      }),
      scopedPrisma: ScopedDb,
    }),
  ],
  providers: [Caller, { provide: APP_FILTER, useClass: ScopedRowNotFoundFilter }],
  exports: [PgbaseModule, Caller],
})
export class AppPgbaseModule {}
