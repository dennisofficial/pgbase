import { Controller, Get } from '@nestjs/common';
import { Caller } from '../pgbase/caller';
import { ScopedDb } from '../pgbase/scoped-db';

@Controller('me')
export class MeController {
  constructor(
    private readonly db: ScopedDb,
    private readonly caller: Caller,
  ) {}

  @Get()
  async profile() {
    const [user, orgs, teammates] = await Promise.all([
      this.db.user.findUnique({ where: { id: this.caller.userId } }),
      this.db.org.findMany(),
      this.db.user.findMany({ orderBy: { name: 'asc' } }),
    ]);
    return { user, orgs, teammates };
  }
}
