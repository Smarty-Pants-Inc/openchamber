// smarty-code#1407: the Smarties a signed-in person may see (their own and those Paul shares), each one's feed, and
// messages to their own Smarty, through the gateway's /me/smarties routes. The gateway decides who the person is and
// what they may see or send; this module only parses its answers.
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';

const smartySchema = z.object({ id: z.string().min(1), label: z.string().min(1), own: z.boolean(), writable: z.boolean() });
const listSchema = z.object({ me: z.string().min(1), smarties: z.array(smartySchema) });
const blockSchema = z.object({ id: z.string().min(1), author: z.string().min(1), at: z.string(), text: z.string() });
// `earlier` (the gateway's paging cursor): the `before` for the page above this one; null at the top of the feed. A read
// of appended blocks (`after`) omits it.
const feedSchema = z.object({ blocks: z.array(blockSchema), offset: z.number().int().nonnegative(), earlier: z.number().int().nonnegative().nullable().optional() });

export type Smarty = z.infer<typeof smartySchema>;
export type SmartyBlock = z.infer<typeof blockSchema>;
export type SmartyFeed = z.infer<typeof feedSchema>;
/** `unavailable`: this server has no Smarties (no gateway route, or the person is not a principal). Never a failure. */
export type SmartiesResult = { state: 'ready'; me: string; smarties: Smarty[] } | { state: 'unavailable' };
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export class SmartiesRequestError extends Error {
  /** `serverMessage`: the gateway's own plain words for a refusal (a 413 "Message is too long…"), when it gave any. */
  constructor(readonly status: number, readonly serverMessage?: string) { super(`Smarties request failed (${status})`); }
}

const parseJson = (text: string) => { try { return JSON.parse(text); } catch { return null; } };
// The gateway answers {name, data: {message}} (packages/gateway/src/errors.ts errorResponse); a top-level error/message is accepted too.
const refusalSchema = z.object({ error: z.string().optional(), message: z.string().optional(), data: z.object({ message: z.string().optional() }).optional() });
/** A refusal's message: a JSON `error` or `message`, or a short plain-text body. Never an HTML error page. */
/** At most `limit` bytes of a body, then the rest is cancelled: a huge or endless error body can't hold the page (#567 security). */
async function boundedText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); size += value.byteLength;
    }
  } catch { return ''; } finally { void reader.cancel().catch(() => undefined); }
  const all = new Uint8Array(Math.min(size, limit));
  let at = 0;
  for (const chunk of chunks) { const part = chunk.subarray(0, all.length - at); all.set(part, at); at += part.length; if (at >= all.length) break; }
  return new TextDecoder().decode(all);
}
async function refusalMessage(response: Response): Promise<string | undefined> {
  const type = response.headers.get('content-type') ?? '';
  const body = await boundedText(response, 4096);
  const parsed = type.includes('json') ? refusalSchema.safeParse(parseJson(body)) : undefined;
  const text = (parsed ? (parsed.success ? parsed.data.data?.message ?? parsed.data.error ?? parsed.data.message : undefined) : type.startsWith('text/plain') ? body : undefined)?.trim();
  return text && text.length <= 500 ? text : undefined;
}

const read = { credentials: 'include', headers: { accept: 'application/json' } } satisfies RequestInit;
// The gateway serves /me/smarties (SMARTIES_API_PATH); OpenChamber's /api prefix maps onto it, as /api/inbox does.
const SMARTIES_API = '/api/me/smarties';
const smartyPath = (id: string) => `${SMARTIES_API}/${encodeURIComponent(id)}`;

export async function loadSmarties(fetcher: Fetcher = runtimeFetch): Promise<SmartiesResult> {
  const response = await fetcher(SMARTIES_API, read);
  // ponytail: a 404 is a server without the Smarties route (VS Code, a plain OpenChamber); 403 is a person with no Smarty.
  if (response.status === 404 || response.status === 403) return { state: 'unavailable' };
  if (!response.ok) throw new SmartiesRequestError(response.status);
  const body = listSchema.parse(await response.json());
  if (body.smarties.length === 0) return { state: 'unavailable' };
  // Own first, whatever order the server sent.
  return { state: 'ready', me: body.me, smarties: [...body.smarties].sort((a, b) => Number(b.own) - Number(a.own)) };
}

/** The newest blocks (no `after`/`before`), the blocks appended after a byte offset, or a page that ends before one. */
export type FeedQuery = { after?: number; before?: number; limit?: number };
export async function loadSmartyFeed(id: string, query: FeedQuery = {}, fetcher: Fetcher = runtimeFetch): Promise<SmartyFeed> {
  const params = new URLSearchParams();
  for (const name of ['after', 'before', 'limit'] as const) { const value = query[name]; if (value !== undefined) params.set(name, String(value)); }
  const search = params.size ? `?${params}` : '';
  const response = await fetcher(`${smartyPath(id)}/feed${search}`, read);
  if (!response.ok) throw new SmartiesRequestError(response.status);
  return feedSchema.parse(await response.json());
}

/** Resolves on 202; a refusal or failure throws (a refusal with the gateway's message), so the caller can give the text back. */
export async function sendSmartyMessage(id: string, text: string, clientId: string, fetcher: Fetcher = runtimeFetch): Promise<void> {
  const response = await fetcher(`${smartyPath(id)}/messages`, {
    method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ text, clientId }) });
  if (!response.ok) throw new SmartiesRequestError(response.status, await refusalMessage(response));
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
  source.addEventListener('blocks', (event: MessageEvent<string>) => {
    const parsed = feedSchema.safeParse(parseJson(event.data));
    if (parsed.success) handlers.onBlocks(parsed.data);
  });
  source.onerror = () => { dropped = true; };
  source.onopen = () => { if (dropped) { dropped = false; handlers.onReconnect(); } };
  return { close: () => source.close() };
}
