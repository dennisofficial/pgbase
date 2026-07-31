import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from './prisma/prisma.service.js';
import type { ScopedDb } from './pgbase/scoped-db.js';

export interface RawAuditLogRow {
  readonly id: string;
  readonly action: string;
  readonly actorId: string | null;
  readonly at: string;
}

function parseId(id: string): bigint {
  if (!/^\d+$/.test(id)) throw new BadRequestException(`"${id}" is not a valid AuditLog id.`);
  return BigInt(id);
}

/** AuditLog is the one model in this schema with an omit list covering every column but its
 * primary key (see pgbasePolicies.AuditLog) — everything a subscriber gets back is `{ id }`.
 * `readRaw` goes around pgbase entirely, straight to Prisma, purely so the demo page can show
 * what's actually in the row next to what the client received. It is not part of the pgbase
 * transport and a real app would not expose it. */
export class AuditLogSimulationService {
  constructor(
    private readonly db: ScopedDb,
    private readonly prisma: PrismaService,
  ) {}

  async create(actorId: string, action: string): Promise<{ id: string }> {
    const created = await this.db.auditLog.create({ data: { actorId, action } });
    return { id: created.id.toString() };
  }

  async remove(id: string): Promise<void> {
    await this.prisma.auditLog.delete({ where: { id: parseId(id) } }).catch(() => {});
  }

  async readRaw(id: string): Promise<RawAuditLogRow> {
    const row = await this.prisma.auditLog.findUnique({ where: { id: parseId(id) } });
    if (!row) throw new NotFoundException(`No AuditLog row with id ${id}.`);
    return { id: row.id.toString(), action: row.action, actorId: row.actorId, at: row.at.toISOString() };
  }
}
