import { requireContext } from '@dltech/pgbase/context';
import { AsyncLocalStorageContextStore } from '@dltech/pgbase/nest';
import { ForbiddenException, Injectable } from '@nestjs/common';
import type { Claims, Principal } from '../pgbase/claims';

@Injectable()
export class Caller {
  constructor(private readonly context: AsyncLocalStorageContextStore<Principal, Claims>) {}

  get claims(): Claims {
    return requireContext(this.context).claims;
  }

  get userId(): string {
    return this.claims.userId;
  }

  /** The org new rows are created in. A real app would let a member pick; this example has one. */
  get orgId(): string {
    const [orgId] = this.claims.orgIds;
    if (!orgId) throw new ForbiddenException('This user is not a member of any org.');
    return orgId;
  }
}
