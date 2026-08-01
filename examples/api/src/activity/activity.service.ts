import { Injectable } from '@nestjs/common';
import { Caller } from '../pgbase/caller';
import { ScopedDb } from '../pgbase/scoped-db';

@Injectable()
export class ActivityService {
  constructor(
    private readonly db: ScopedDb,
    private readonly caller: Caller,
  ) {}

  async record(action: string): Promise<void> {
    await this.db.auditLog.create({ data: { actorId: this.caller.userId, action } });
  }
}
