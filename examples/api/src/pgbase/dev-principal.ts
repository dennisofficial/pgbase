import { UnauthorizedException } from '@nestjs/common';
import type { Principal } from './claims';

export const DEV_USER_HEADER = 'x-pgbase-dev-user';

interface RequestLike {
  readonly headers?: Record<string, string | string[] | undefined>;
  /** socket.io's handshake carries this; an HTTP request does not. */
  readonly auth?: Record<string, unknown>;
}

export function getPrincipal(req: unknown): Principal {
  const like = req as RequestLike;
  const header = like.headers?.[DEV_USER_HEADER];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  const fromAuth = like.auth?.[DEV_USER_HEADER];
  const userId = fromHeader ?? (typeof fromAuth === 'string' ? fromAuth : undefined);
  if (!userId) {
    throw new UnauthorizedException(
      `Missing "${DEV_USER_HEADER}" (dev-only stand-in for auth). Send it as a header over HTTP, ` +
        `or in socket.io's "auth" payload over a socket — a browser WebSocket cannot send headers.`,
    );
  }
  return userId;
}
