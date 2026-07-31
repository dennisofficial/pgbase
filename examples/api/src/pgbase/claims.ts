import { Injectable, Module, UnauthorizedException } from '@nestjs/common';
import type { ClaimsBuilder } from '@dltech/pgbase/context';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The principal is just a user id — this example has no session/token layer, see JobsController. */
export type Principal = string;

export interface Claims {
  readonly userId: string;
  readonly orgIds: readonly string[];
  readonly visibleUserIds: readonly string[];
}

@Injectable()
export class OrgMembershipClaimsBuilder implements ClaimsBuilder<Principal, Claims> {
  constructor(private readonly prisma: PrismaService) {}

  key(principal: Principal): string {
    return principal;
  }

  async build(userId: Principal): Promise<Claims> {
    if (!UUID_RE.test(userId)) throw new UnauthorizedException('principal is not a user id');

    const own = await this.prisma.membership.findMany({
      where: { userId },
      select: { orgId: true },
    });
    const orgIds = own.map((m) => m.orgId);
    if (orgIds.length === 0) return { userId, orgIds: [], visibleUserIds: [userId] };

    const coMembers = await this.prisma.membership.findMany({
      where: { orgId: { in: orgIds } },
      select: { userId: true },
      distinct: ['userId'],
    });
    return { userId, orgIds, visibleUserIds: coMembers.map((m) => m.userId) };
  }
}

@Module({
  imports: [PrismaModule],
  providers: [OrgMembershipClaimsBuilder],
  exports: [OrgMembershipClaimsBuilder],
})
export class ClaimsModule {}
