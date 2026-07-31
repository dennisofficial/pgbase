import { Controller, Get } from '@nestjs/common';
import { ScopedDb } from './pgbase/scoped-db';
import { Caller } from './work/caller';

@Controller()
export class AppController {
  constructor(
    private readonly db: ScopedDb,
    private readonly caller: Caller,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  /**
   * The ScopedPrisma surface, used the way an app actually would. Note what is missing: no
   * `where` narrows these to the caller's org. The scoped client adds each model's RLS predicate,
   * so the identical query returns a different result set per caller.
   */
  @Get('me')
  async me() {
    const [user, orgs, teammates] = await Promise.all([
      this.db.user.findUnique({ where: { id: this.caller.userId } }),
      this.db.org.findMany(),
      this.db.user.findMany({ orderBy: { name: 'asc' } }),
    ]);
    return { user, orgs, teammates };
  }
}
