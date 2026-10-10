// smarty-code#1407: the Smarties a signed-in person may see (their own and those Paul shares), each one's feed, and
// messages to their own Smarty, through the gateway's /me/smarties routes. The gateway decides who the person is and
// what they may see or send; this module only parses its answers.
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';

// smarty-code#1490: what the Smarty's agent is doing, as the gateway saw it (Herdr's status and the feed's last write).
// Durations, not clock times: the browser anchors them when the answer arrives. A value it does not know reads unknown.
const STATES = ['working', 'waiting', 'idle', 'blocked', 'offline', 'unknown'] as const;
const activitySchema = z.object({ state: z.enum(STATES).catch('unknown'), workingForMs: z.number().nonnegative().nullable().catch(null),
  lastActiveAgoMs: z.number().nonnegative().nullable().catch(null) });
const smartySchema = z.object({ id: z.string().min(1), label: z.string().min(1), own: z.boolean(), writable: z.boolean(), activity: activitySchema.optional() });
// `me` is null for a signed-in member the gateway maps to no person (smarty-code#1456): valid only with no Smarties.
const listSchema = z.object({ me: z.string().min(1).nullable(), smarties: z.array(smartySchema) })
  .refine(body => body.me !== null || body.smarties.length === 0)
  // Shared-only lists are valid; ownership and write permission must still agree with the signed-in person.
  .refine(body => body.smarties.every(smarty => smarty.own === (smarty.id === body.me) && smarty.writable === smarty.own))
  .refine(body => body.smarties.filter(smarty => smarty.own).length <= 1);
const blockSchema = z.object({ id: z.string().min(1), author: z.string().min(1), at: z.string(), text: z.string() });
// `earlier` (the gateway's paging cursor): the `before` for the page above this one; null at the top of the feed. A read
// of appended blocks (`after`) omits it.
const feedSchema = z.object({ blocks: z.array(blockSchema), offset: z.number().int().nonnegative(), earlier: z.number().int().nonnegative().nullable().optional() });

export type SmartyState = (typeof STATES)[number];
/** Browser-clock times; null: not known (a turn already running when the gateway first saw it, or no feed yet). */
export type SmartyActivity = { state: SmartyState; startedAt: number | null; lastActiveAt: number | null };
/** No `activity`: a gateway that does not report it, so the view shows no status rather than a guess. */
export type Smarty = Omit<z.infer<typeof smartySchema>, 'activity'> & { activity?: SmartyActivity };
export const toActivity = (wire: z.infer<typeof activitySchema>, now = Date.now()): SmartyActivity => ({ state: wire.state,
  startedAt: wire.state === 'working' && wire.workingForMs !== null ? now - wire.workingForMs : null,
  lastActiveAt: wire.lastActiveAgoMs === null ? null : now - wire.lastActiveAgoMs });
export type SmartyBlock = z.infer<typeof blockSchema>;
export type SmartyFeed = z.infer<typeof feedSchema>;
/**
 * `unavailable`: this server has no Smarties (no gateway route). `empty`: it has, but none this person may see (they are
 * not a principal, smarty-code#1456): the view says so and keeps its button to the old view. Neither is a failure.
 */
export type SmartiesResult = { state: 'ready'; me: string; smarties: Smarty[] } | { state: 'empty' } | { state: 'unavailable' };
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
async function boundedText(response: Response, limit: number, timeoutMs = 3000): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const all = new Uint8Array(limit);
  let at = 0, timer: ReturnType<typeof setTimeout> | undefined;
  // A stalled body gives up after timeoutMs; each chunk keeps only the bytes still within the limit (#567 r4).
  const stalled = new Promise<'stalled'>(resolve => { timer = setTimeout(() => resolve('stalled'), timeoutMs); });
  try {
    while (at < limit) {
      const next = await Promise.race([reader.read(), stalled]);
      if (next === 'stalled') return '';
      if (next.done) break;
      const part = next.value.subarray(0, limit - at);
      all.set(part, at); at += part.length;
    }
  } catch { return ''; } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
  }
  return new TextDecoder().decode(all.subarray(0, at));
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
  // ponytail: only a 404 means no Smarties route (VS Code, a plain OpenChamber); a refusal or partial answer is a failure.
  if (response.status === 404) return { state: 'unavailable' };
  if (response.status !== 200) throw new SmartiesRequestError(response.status);
  const body = listSchema.parse(await response.json());
  if (body.smarties.length === 0 || body.me === null) return { state: 'empty' };
  // Own first, whatever order the server sent.
  const now = Date.now(), smarties = body.smarties.map(({ activity, ...smarty }) => activity ? { ...smarty, activity: toActivity(activity, now) } : smarty);
  return { state: 'ready', me: body.me, smarties: smarties.sort((a, b) => Number(b.own) - Number(a.own)) };
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
export function openSmartyStream(id: string, handlers: { onBlocks: (feed: SmartyFeed) => void; onReconnect: () => void; onStatus?: (activity: SmartyActivity) => void }): SmartyStream {
  if (!globalThis.EventSource) return { close: () => undefined };
  const source = new EventSource(getRuntimeUrlResolver().sse(`${smartyPath(id)}/stream`), { withCredentials: true });
  let dropped = false;
  source.addEventListener('blocks', (event: MessageEvent<string>) => {
    const parsed = feedSchema.safeParse(parseJson(event.data));
    if (parsed.success) handlers.onBlocks(parsed.data);
  });
  // #1490: the Smarty's activity at connect and at each change.
  source.addEventListener('status', (event: MessageEvent<string>) => {
    const parsed = activitySchema.safeParse(parseJson(event.data));
    if (parsed.success) handlers.onStatus?.(toActivity(parsed.data));
  });
  source.onerror = () => { dropped = true; };
  source.onopen = () => { if (dropped) { dropped = false; handlers.onReconnect(); } };
  return { close: () => source.close() };
}
