import { API_URL, getAuthHeaders } from '../pgbase/client';

/**
 * Writes. There is no read counterpart: everything this app displays comes from pgbase live
 * subscriptions, and no response below is used to update the UI — the WAL does that.
 */
export async function write(path: string, method: string, body?: unknown): Promise<void> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...getAuthHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await messageOf(res));
}

async function messageOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
  const message = body?.message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.join(', ');
  return `Request failed with ${res.status}.`;
}
