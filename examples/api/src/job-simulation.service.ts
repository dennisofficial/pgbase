import { ScopedRowNotFoundError } from '@workspace/pgbase/nest';
import type { JobStatus } from './generated/prisma/enums.js';
import type { ScopedDb } from './pgbase/scoped-db.js';

export class JobSimulationService {
  constructor(private readonly db: ScopedDb) {}

  create(orgId: string, name: string, status?: JobStatus) {
    return this.db.job.create({ data: { orgId, name, status } });
  }

  setStatus(id: string, status: JobStatus) {
    return this.db.job.update({ where: { id }, data: { status } });
  }

  async remove(id: string): Promise<void> {
    try {
      await this.db.job.delete({ where: { id } });
    } catch (err) {
      // Already gone (e.g. a demo re-run, or the caller can no longer see it) — cleanup is
      // best-effort, not a failure the page needs to surface.
      if (!(err instanceof ScopedRowNotFoundError)) throw err;
    }
  }
}
