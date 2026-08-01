import { describe, expect, it } from 'vitest';
import { toPgbaseRequest } from '../request.js';

describe('toPgbaseRequest', () => {
  it('lowercases header names and flattens repeated values to the first', () => {
    const req = toPgbaseRequest(
      { headers: { Authorization: 'Bearer t', 'X-Trace': ['a', 'b'], nope: 42 } },
      'http',
    );

    expect(req.headers).toEqual({ authorization: 'Bearer t', 'x-trace': 'a' });
    expect(req.credential('Authorization')).toBe('Bearer t');
  });

  /**
   * The whole point: one lookup has to work for a fetch and for a socket handshake, because a
   * browser WebSocket cannot send headers and the credential moves to `auth` there.
   */
  it('finds a credential in the handshake auth payload over a socket', () => {
    const req = toPgbaseRequest({ headers: {}, auth: { authorization: 'Bearer t' } }, 'socket');

    expect(req.kind).toBe('socket');
    expect(req.credential('authorization')).toBe('Bearer t');
  });

  it('prefers a header over auth when a socket sends both', () => {
    const req = toPgbaseRequest(
      { headers: { authorization: 'from-header' }, auth: { authorization: 'from-auth' } },
      'socket',
    );

    expect(req.credential('authorization')).toBe('from-header');
  });

  // An HTTP request body is attacker-controlled and could carry an `auth` key; reading it here
  // would let a caller supply credentials the header path never checked.
  it('ignores auth on an HTTP request', () => {
    const req = toPgbaseRequest({ headers: {}, auth: { authorization: 'smuggled' } }, 'http');

    expect(req.auth).toEqual({});
    expect(req.credential('authorization')).toBeUndefined();
  });

  it('survives a request with nothing on it', () => {
    const req = toPgbaseRequest(undefined, 'http');

    expect(req.headers).toEqual({});
    expect(req.credential('authorization')).toBeUndefined();
    expect(req.raw).toBeUndefined();
  });
});
