// smarty-code#701: Code's view of the person's smarty-inbox (the same store as Herdr's /inbox), through the gateway's
// /inbox routes. The gateway decides whose inbox it is (the signed-in email) and checks each item is theirs.
import { z } from 'zod';
import { create } from 'zustand';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';

const itemSchema = z.object({
  id: z.string().min(1), to: z.string(), title: z.string(),
  why: z.string().optional(), recommendation: z.string().optional(), source: z.string().optional(), createdBy: z.string().optional(),
  actions: z.array(z.string()).default([]),
  links: z.array(z.object({ url: z.string(), label: z.string().optional() })).default([]),
  priority: z.string().default('normal'), created: z.string(), updated: z.string(),
  snoozedUntil: z.string().optional(),
  answer: z.object({ at: z.string(), action: z.string().optional(), by: z.string().optional(), text: z.string().optional() }).optional(),
  resolved: z.object({ at: z.string(), by: z.string().optional(), action: z.string().optional(), note: z.string().optional() }).optional(),
});
export type InboxItem = z.infer<typeof itemSchema>;
export type InboxState = 'open' | 'snoozed' | 'resolved';
export type InboxAction = 'answer' | 'resolve' | 'snooze' | 'reopen';
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export const inboxItemState = (item: InboxItem, now = Date.now()): InboxState =>
  item.resolved ? 'resolved' : item.snoozedUntil && Date.parse(item.snoozedUntil) > now ? 'snoozed' : 'open';

/** P0 first (the mock's red rows), then the newest. */
export const sortInboxItems = (items: InboxItem[]) => [...items].sort((a, b) =>
  Number(b.priority === 'p0') - Number(a.priority === 'p0') || b.created.localeCompare(a.created));

/** Only http(s) links become anchors; anything else is shown as text. */
export const safeLink = (url: string) => { try { return ['https:', 'http:'].includes(new URL(url).protocol) ? url : null; } catch { return null; } };

const failure = async (response: Response) => {
  const body = await response.json().catch(() => null) as { data?: { message?: unknown } } | null;
  return new Error(typeof body?.data?.message === 'string' ? body.data.message : `Inbox request failed (${response.status})`);
};

/** The list for one tab; a 403 means this account has no inbox (the page shows no badge). */
export async function loadInbox(state: InboxState, fetcher: Fetcher = runtimeFetch): Promise<{ available: boolean; items: InboxItem[] }> {
  const response = await fetcher(`/api/inbox?state=${state}`, { credentials: 'include', headers: { accept: 'application/json' } });
  if (response.status === 403) return { available: false, items: [] };
  if (!response.ok) throw await failure(response);
  const body = await response.json() as { items?: unknown[] };
  const items = (body.items ?? []).flatMap(value => { const parsed = itemSchema.safeParse(value); return parsed.success ? [parsed.data] : []; });
  return { available: true, items: sortInboxItems(items) };
}

/** One write, with only the documented body fields (the gateway refuses others); returns the item after it. */
export async function actOnInboxItem(id: string, action: InboxAction, body: Record<string, string>, fetcher: Fetcher = runtimeFetch) {
  const response = await fetcher(`/api/inbox/${encodeURIComponent(id)}/${action}`, {
    method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw await failure(response);
  return itemSchema.parse((await response.json() as { item: unknown }).item);
}

type Store = {
  available: boolean; openCount: number; p0Count: number; pageOpen: boolean; revision: number;
  setOpenItems: (available: boolean, items: InboxItem[]) => void; setPageOpen: (open: boolean) => void;
};
export const useInboxStore = create<Store>(set => ({
  available: false, openCount: 0, p0Count: 0, pageOpen: false, revision: 0,
  setOpenItems: (available, items) => set(s => ({ available, openCount: items.length,
    p0Count: items.filter(i => i.priority === 'p0').length, revision: s.revision + 1 })),
  setPageOpen: pageOpen => set({ pageOpen }),
}));

export const refreshInboxBadge = () => loadInbox('open').then(r => useInboxStore.getState().setOpenItems(r.available, r.items), () => {});

/** Retries of a first load that failed (a network error, a gateway restart): 5 s, 15 s, then every 60 s. */
export const INBOX_RETRY_MS = [5_000, 15_000, 60_000];

/**
 * The badge: the open list now, then again on each watch event (the event carries no priorities). A first load that
 * fails is retried (#365 review: one transient error must not remove the only entry point for the whole visit); a 403
 * (this account has no inbox) is an answer, and ends it.
 */
export function watchInbox(load = () => loadInbox('open'), retryMs = INBOX_RETRY_MS): () => void {
  let source: EventSource | undefined, closed = false, timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = (n: number) => {
    void load().then(r => {
      if (closed) return;
      useInboxStore.getState().setOpenItems(r.available, r.items);
      if (!r.available || typeof EventSource === 'undefined') return;
      source = new EventSource(getRuntimeUrlResolver().sse('/api/inbox/events'), { withCredentials: true });
      source.onmessage = () => { void refreshInboxBadge(); };
    }, () => { if (!closed) timer = setTimeout(() => attempt(n + 1), retryMs[Math.min(n, retryMs.length - 1)]); });
  };
  attempt(0);
  return () => { closed = true; clearTimeout(timer); source?.close(); };
}
