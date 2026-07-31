import { ScopedPrismaToken } from '@dltech/pgbase/nest';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { pgbasePolicies } from './policies.js';

export class ScopedDb extends ScopedPrismaToken<PrismaClient, typeof pgbasePolicies>() {}
