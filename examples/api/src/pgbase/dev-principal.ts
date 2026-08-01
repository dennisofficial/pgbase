import type { PgbaseRequest } from '@dltech/pgbase/context';
import { UnauthorizedException } from '@nestjs/common';
import type { Principal } from './claims';

export const DEV_USER_HEADER = 'x-pgbase-dev-user';

/**
 * DEV-ONLY: the caller names a seeded user by id. There is no session, token, or password anywhere
 * in this example — replace this before it is anything but a harness.
 *
 * One lookup covers both transports. `credential` reads headers first, then socket.io's handshake
 * `auth`, which is where a browser has to put this: the WebSocket API cannot set request headers.
 */
export function getPrincipal(req: PgbaseRequest): Principal {
  const userId = req.credential(DEV_USER_HEADER);
  if (!userId) {
    throw new UnauthorizedException(
      `Missing "${DEV_USER_HEADER}" (dev-only stand-in for auth). Send it as a header over HTTP, ` +
        `or in socket.io's "auth" payload over a socket.`,
    );
  }
  return userId;
}
