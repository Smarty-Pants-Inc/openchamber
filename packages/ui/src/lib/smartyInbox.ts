// smarty-code#701: Code's view of the person's smarty-inbox (the same store as Herdr's /inbox), through the gateway's
// /inbox routes. The gateway decides whose inbox it is (the signed-in email) and checks each item is theirs.
import { z } from 'zod';
import { create } from 'zustand';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { captureRuntimeRequestScope, isRuntimeRequestScopeCurrent, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

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
type SnapshotDetails = { capabilities?: { guardedReopen: boolean }; invalidStepGroups?: string[] };
type InboxListResult = SnapshotDetails & { available: boolean; items: InboxItem[] };

export const inboxItemState = (item: InboxItem, now = Date.now()): InboxState =>
  item.resolved ? 'resolved' : item.snoozedUntil && Date.parse(item.snoozedUntil) > now ? 'snoozed' : 'open';

/** P0 first (the mock's red rows), then the newest. */
export const sortInboxItems = (items: InboxItem[]) => [...items].sort((a, b) =>
  Number(b.priority === 'p0') - Number(a.priority === 'p0') || b.created.localeCompare(a.created));

/** Only http(s) links become anchors; anything else is shown as text. */
export const safeLink = (url: string) => { try { return ['https:', 'http:'].includes(new URL(url).protocol) ? url : null; } catch { return null; } };

export class InboxRequestError extends Error {
  constructor(message: string, readonly uncertain: boolean) { super(message); }
}
const failure = async (response: Response) => {
  const body = z.object({ data: z.object({ message: z.string().optional(), code: z.string().optional() }).optional() }).safeParse(await response.json().catch(() => null));
  const unsupportedGuard = response.status === 501 && body.success && body.data.data?.code === 'smarty.inbox-guard-unavailable';
  return new InboxRequestError(body.success && body.data.data?.message || `Inbox request failed (${response.status})`, !unsupportedGuard && (response.status >= 500 || response.status === 408));
};

/** The list for one tab; a 403 means this account has no inbox (the page shows no badge). */
export async function loadInbox(state: InboxState | 'all', fetcher: Fetcher = runtimeFetch): Promise<InboxListResult> {
  const response = await fetcher(`/api/inbox?state=${state}`, { credentials: 'include', headers: { accept: 'application/json' } });
  if (response.status === 403) return { available: false, items: [] };
  if (!response.ok) throw await failure(response);
  const body = z.object({ items: z.array(z.json()), person: z.string().optional(),
    capabilities: z.object({ guardedReopen: z.boolean() }).optional() }).parse(await response.json());
  const items: InboxItem[] = [], invalidStepGroups: string[] = [];
  const person = state === 'all' ? z.string().min(1).parse(body.person) : body.person;
  for (const value of body.items) {
    const parsed = itemSchema.safeParse(value);
    if (parsed.success && (state !== 'all' || parsed.data.to === person)) { items.push(parsed.data); continue; }
    // Keep a malformed member's claimed group as a blocker. One broken list cannot erase another valid list.
    const claim = z.object({ source: z.string(), to: z.string().optional() }).safeParse(value);
    if (state === 'all' && claim.success && (!claim.data.to || claim.data.to === person) && claim.data.source.startsWith('steps:v1:')) {
      invalidStepGroups.push(JSON.stringify([person, claim.data.source.split(':')[2] ?? '']));
    }
  }
  const result = { available: true, items: sortInboxItems(items) };
  return state === 'all' ? { ...result, capabilities: body.capabilities ?? { guardedReopen: false }, invalidStepGroups } : result;
}

/** One write, with only the documented body fields (the gateway refuses others); returns the item after it. */
export async function actOnInboxItem(id: string, action: InboxAction, body: Record<string, string>, fetcher: Fetcher = runtimeFetch) {
  const response = await fetcher(`/api/inbox/${encodeURIComponent(id)}/${action}`, {
    method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw await failure(response);
  return z.object({ item: itemSchema }).parse(await response.json()).item;
}

export async function loadInboxItem(id: string, fetcher: Fetcher = runtimeFetch): Promise<InboxItem> {
  const response = await fetcher(`/api/inbox/${encodeURIComponent(id)}`, { credentials: 'include', headers: { accept: 'application/json' } });
  if (!response.ok) throw await failure(response);
  return z.object({ item: itemSchema }).parse(await response.json()).item;
}

type Store = {
  available: boolean; openCount: number; p0Count: number; pageOpen: boolean; revision: number; items: InboxItem[]; snapshotValid: boolean; guardedReopen: boolean; invalidStepGroups: string[];
  setOpenItems: (available: boolean, items: InboxItem[]) => void; setPageOpen: (open: boolean) => void;
  setItems: (available: boolean, items: InboxItem[], details?: SnapshotDetails) => void;
  recordItem: (item: InboxItem) => void;
  invalidateSnapshot: () => void;
};
export const useInboxStore = create<Store>(set => ({
  available: false, openCount: 0, p0Count: 0, pageOpen: false, revision: 0, items: [], snapshotValid: false, guardedReopen: false, invalidStepGroups: [],
  setOpenItems: (available, items) => set(s => ({ available, openCount: items.length,
    p0Count: items.filter(i => i.priority === 'p0').length, revision: s.revision + 1 })),
  setPageOpen: pageOpen => set({ pageOpen }),
  setItems: (available, items, details) => set(s => {
    const open = items.filter(i => inboxItemState(i) === 'open');
    return { available, items, snapshotValid: available, guardedReopen: details?.capabilities?.guardedReopen ?? false,
      invalidStepGroups: details?.invalidStepGroups ?? [], openCount: open.length, p0Count: open.filter(i => i.priority === 'p0').length, revision: s.revision + 1 };
  }),
  invalidateSnapshot: () => set({ snapshotValid: false }),
  recordItem: item => set(s => {
    const current = s.items.find(i => i.id === item.id);
    if (current && Date.parse(current.updated) > Date.parse(item.updated)) return s;
    const items = [...s.items.filter(i => i.id !== item.id), item];
    // Retained history is not badge authority after an open-only fallback.
    if (!s.snapshotValid) return { items, revision: s.revision + 1 };
    const open = items.filter(i => inboxItemState(i) === 'open');
    return { items, openCount: open.length, p0Count: open.filter(i => i.priority === 'p0').length, revision: s.revision + 1 };
  }),
}));

// The normal path remains one all GET. A failed history read must not hide the ordinary open Inbox.
async function loadWatchSnapshot(load: () => Promise<InboxListResult>, current: () => boolean) {
  try { return { complete: true, result: await load() }; }
  catch {
    if (!current()) return null;
    return { complete: false, result: await loadInbox('open') };
  }
}
function applyWatchSnapshot(snapshot: NonNullable<Awaited<ReturnType<typeof loadWatchSnapshot>>>) {
  const store = useInboxStore.getState(), r = snapshot.result;
  if (snapshot.complete) { store.setItems(r.available, r.items, r); return; }
  store.setOpenItems(r.available, r.items);
  store.invalidateSnapshot(); // Open is badge authority, never a silently reduced Steps snapshot.
}
let latestInboxRefresh = 0;
export const refreshInboxBadge = async () => {
  const generation = ++latestInboxRefresh;
  const scope = captureRuntimeRequestScope(), revision = useInboxStore.getState().revision;
  const current = () => generation === latestInboxRefresh && isRuntimeRequestScopeCurrent(scope) && revision === useInboxStore.getState().revision;
  try {
    const snapshot = await loadWatchSnapshot(() => loadInbox('all'), current);
    if (snapshot && current()) applyWatchSnapshot(snapshot);
  } catch {
    // Keep text/progress visible, but a malformed or unavailable list cannot grant actionable group authority.
    if (current()) useInboxStore.getState().invalidateSnapshot();
  }
};

/** Retries of a first load that failed (a network error, a gateway restart): 5 s, 15 s, then every 60 s. */
export const INBOX_RETRY_MS = [5_000, 15_000, 60_000];

/**
 * The badge and Steps share one all-state read on each existing watch event. If history fails, an open-only
 * fallback keeps the Inbox and this same subscription available, without granting Steps authority. Failed first
 * loads retry; a 403 (this account has no inbox) is an answer, and ends bootstrap.
 */
export function watchInbox(load = () => loadInbox('all'), retryMs = INBOX_RETRY_MS): () => void {
  let scope = captureRuntimeRequestScope();
  let source: EventSource | undefined, closed = false, timer: ReturnType<typeof setTimeout> | undefined;
  useInboxStore.getState().setItems(false, []);
  const attempt = (n: number) => {
    const revision = useInboxStore.getState().revision, requestScope = scope;
    const current = () => !closed && requestScope === scope && isRuntimeRequestScopeCurrent(requestScope);
    void loadWatchSnapshot(load, current).then(snapshot => {
      if (!snapshot || !current()) return;
      if (revision === useInboxStore.getState().revision) applyWatchSnapshot(snapshot);
      if (!snapshot.result.available || !globalThis.EventSource) return;
      source = new EventSource(getRuntimeUrlResolver().sse('/api/inbox/events'), { withCredentials: true });
      source.onmessage = () => { if (!closed && requestScope === scope) void refreshInboxBadge(); };
    }, () => { if (current()) timer = setTimeout(() => attempt(n + 1), retryMs[Math.min(n, retryMs.length - 1)]); });
  };
  const unsubscribe = subscribeRuntimeEndpointChanged(() => {
    source?.close(); clearTimeout(timer);
    scope = captureRuntimeRequestScope();
    useInboxStore.getState().setItems(false, []);
    attempt(0);
  });
  attempt(0);
  return () => { closed = true; unsubscribe(); clearTimeout(timer); source?.close(); };
}
