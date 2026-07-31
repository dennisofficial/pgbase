import { Injectable } from '@nestjs/common';
import { ScopedDb } from '../pgbase/scoped-db';
import { Caller } from './caller';

@Injectable()
export class ActivityService {
  constructor(
    private readonly scopedDB: ScopedDb,
    private readonly caller: Caller,
  ) {}

  async record(action: string): Promise<void> {
    await this.scopedDB.auditLog.create({ data: { actorId: this.caller.userId, action } });
  }
}
