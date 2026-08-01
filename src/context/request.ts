export interface PgbaseRequest {
  readonly kind: 'http' | 'socket';
  readonly headers: Readonly<Record<string, string>>;
  readonly auth: Readonly<Record<string, string>>;
  readonly credential: (name: string) => string | undefined;
  readonly raw: unknown;
}

function flattenHeaders(source: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof source !== 'object' || source === null) return out;

  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (typeof value === 'string') out[key.toLowerCase()] = value;
    else if (Array.isArray(value) && typeof value[0] === 'string')
      out[key.toLowerCase()] = value[0];
  }
  return out;
}

function stringValues(source: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof source !== 'object' || source === null) return out;

  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

export function toPgbaseRequest(raw: unknown, kind: 'http' | 'socket'): PgbaseRequest {
  const source = raw as { headers?: unknown; auth?: unknown } | null;
  const headers = flattenHeaders(source?.headers);
  // Only a socket handshake has `auth`; reading it over HTTP would let a request body-shaped
  // object smuggle credentials past whatever the header path checks.
  const auth = kind === 'socket' ? stringValues(source?.auth) : {};

  return {
    kind,
    headers,
    auth,
    credential: (name: string): string | undefined => {
      const key = name.toLowerCase();
      return headers[key] ?? auth[name] ?? auth[key];
    },
    raw,
  };
}
