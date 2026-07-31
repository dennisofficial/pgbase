'use client';

import { PgbaseClient } from '@workspace/pgbase/client';
import { io, type Socket } from 'socket.io-client';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export const DEV_USERS = {
  alice: '00000000-0000-4000-8000-0000000000a1',
  carol: '00000000-0000-4000-8000-0000000000b1',
} as const;

export type DevUser = keyof typeof DEV_USERS;

export interface Connection {
  readonly client: PgbaseClient;
  readonly socket: Socket;
}

export function createClient(user: DevUser): Connection {
  const socket = io(API_URL, {
    transports: ['websocket'],
    auth: { 'x-pgbase-dev-user': DEV_USERS[user] },
  });
  return { client: new PgbaseClient({ socket }), socket };
}
