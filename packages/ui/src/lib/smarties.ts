// smarty-code#1407: the Smarties a signed-in person may see (their own and those Paul shares), each one's feed, and
// messages to their own Smarty, through the gateway's /api/smarties routes. The gateway decides who the person is and
// what they may see or send; this module only parses its answers.
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';

const smartySchema = z.object({ id: z.string().min(1), label: z.string().min(1), own: z.boolean(), writable: z.boolean() });
const listSchema = z.object({ me: z.string().min(1), smarties: z.array(smartySchema) });
const blockSchema = z.object({ id: z.string().min(1), author: z.string().min(1), at: z.string(), text: z.string() });
const feedSchema = z.object({ blocks: z.array(blockSchema), offset: z.number().int().nonnegative() });

export type Smarty = z.infer<typeof smartySchema>;
export type SmartyBlock = z.infer<typeof blockSchema>;
export type SmartyFeed = z.infer<typeof feedSchema>;
/** `unavailable`: this server has no Smarties (no gateway route, or the person is not a principal). Never a failure. */
export type SmartiesResult = { state: 'ready'; me: string; smarties: Smarty[] } | { state: 'unavailable' };
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export class SmartiesRequestError extends Error {
  constructor(readonly status: number) { super(`Smarties request failed (${status})`); }
}

const read = { credentials: 'include', headers: { accept: 'application/json' } } satisfies RequestInit;
const smartyPath = (id: string) => `/api/smarties/${encodeURIComponent(id)}`;

export async function loadSmarties(fetcher: Fetcher = runtimeFetch): Promise<SmartiesResult> {
  const response = await fetcher('/api/smarties', read);
  // ponytail: a 404 is a server without the Smarties route (VS Code, a plain OpenChamber); 403 is a person with no Smarty.
  if (response.status === 404 || response.status === 403) return { state: 'unavailable' };
  if (!response.ok) throw new SmartiesRequestError(response.status);
  const body = listSchema.parse(await response.json());
  if (body.smarties.length === 0) return { state: 'unavailable' };
  // Own first, whatever order the server sent.
  return { state: 'ready', me: body.me, smarties: [...body.smarties].sort((a, b) => Number(b.own) - Number(a.own)) };
}

/** The last blocks (no `after`), or the blocks appended after a byte offset. */
export async function loadSmartyFeed(id: string, after?: number, fetcher: Fetcher = runtimeFetch): Promise<SmartyFeed> {
  const query = after === undefined ? '' : `?after=${after}`;
  const response = await fetcher(`${smartyPath(id)}/feed${query}`, read);
  if (!response.ok) throw new SmartiesRequestError(response.status);
  return feedSchema.parse(await response.json());
}

/** Resolves on 202; a refusal or failure throws, so the caller can give the text back. */
export async function sendSmartyMessage(id: string, text: string, clientId: string, fetcher: Fetcher = runtimeFetch): Promise<void> {
  const response = await fetcher(`${smartyPath(id)}/messages`, {
    method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ text, clientId }) });
  if (!response.ok) throw new SmartiesRequestError(response.status);
}

export type SmartyStream = { close: () => void };
/**
 * Appended blocks, live (SSE `event: blocks`). `onReconnect` runs when the stream comes back after a drop, so the
 * caller can fetch what it missed. A malformed event is dropped, never applied.
 */
export function openSmartyStream(id: string, handlers: { onBlocks: (feed: SmartyFeed) => void; onReconnect: () => void }): SmartyStream {
  if (!globalThis.EventSource) return { close: () => undefined };
  const source = new EventSource(getRuntimeUrlResolver().sse(`${smartyPath(id)}/stream`), { withCredentials: true });
  let dropped = false;
  source.addEventListener('blocks', event => {
    const parsed = feedSchema.safeParse((() => { try { return JSON.parse(event.data); } catch { return null; } })());
    if (parsed.success) handlers.onBlocks(parsed.data);
  });
  source.onerror = () => { dropped = true; };
  source.onopen = () => { if (dropped) { dropped = false; handlers.onReconnect(); } };
  return { close: () => source.close() };
}
