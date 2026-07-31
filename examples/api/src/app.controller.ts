import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { AuditLogSimulationService } from './audit-log-simulation.service';
import { JobSimulationService } from './job-simulation.service';
import type { JobStatus } from './generated/prisma/enums';
import { JobCommandService } from './pgbase/job-command.service';
import { JobSummaryService } from './pgbase/job-summary.service';
import { PrismaService } from './prisma/prisma.service';
import { ScopedDb } from './pgbase/scoped-db';

@Controller()
export class AppController {
  private readonly jobSimulation: JobSimulationService;
  private readonly auditLogSimulation: AuditLogSimulationService;

  constructor(
    private readonly jobSummary: JobSummaryService,
    private readonly jobCommands: JobCommandService,
    db: ScopedDb,
    prisma: PrismaService,
  ) {
    this.jobSimulation = new JobSimulationService(db);
    this.auditLogSimulation = new AuditLogSimulationService(db, prisma);
  }

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  /** Demonstrates ScopedPrisma: an RLS-scoped read run server-side on behalf of the caller. */
  @Get('jobs/high-priority-count')
  highPriorityJobCount() {
    return this.jobSummary.highPriorityJobCount();
  }

  /** Writes nothing to any socket — the WAL carries this update to live subscribers on its own. */
  @Post('jobs/:id/bump-priority')
  bumpPriority(@Param('id') id: string) {
    return this.jobCommands.bumpPriority(id);
  }

  // ── Scenario demo simulations ────────────────────────────────────────────────────────────
  // Every write below goes through ScopedDb under the caller's own `x-pgbase-dev-user` header,
  // so a demo page can never write outside what that user's RLS already allows.

  @Post('simulations/jobs')
  createDemoJob(@Body() body: { orgId: string; name: string; status?: JobStatus }) {
    return this.jobSimulation.create(body.orgId, body.name, body.status);
  }

  @Patch('simulations/jobs/:id')
  setDemoJobStatus(@Param('id') id: string, @Body() body: { status: JobStatus }) {
    return this.jobSimulation.setStatus(id, body.status);
  }

  @Delete('simulations/jobs/:id')
  deleteDemoJob(@Param('id') id: string) {
    return this.jobSimulation.remove(id);
  }

  @Post('simulations/audit-log')
  createDemoAuditLog(@Body() body: { actorId: string; action: string }) {
    return this.auditLogSimulation.create(body.actorId, body.action);
  }

  @Delete('simulations/audit-log/:id')
  deleteDemoAuditLog(@Param('id') id: string) {
    return this.auditLogSimulation.remove(id);
  }

  /** Not part of the pgbase transport — a raw, unscoped read used only so the demo page can show
   * what's actually in the row next to what the client received over `findOne`/the socket. */
  @Get('simulations/audit-log/:id/raw')
  readDemoAuditLogRaw(@Param('id') id: string) {
    return this.auditLogSimulation.readRaw(id);
  }
}
