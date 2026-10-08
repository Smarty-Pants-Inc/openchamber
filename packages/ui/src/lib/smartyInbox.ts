// smarty-code#701: Code's view of the person's smarty-inbox (the same store as Herdr's /inbox), through the gateway's
// /inbox routes. The gateway decides whose inbox it is (the signed-in email) and checks each item is theirs.
import { z } from 'zod';
import { create } from 'zustand';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { captureRuntimeRequestScope, isRuntimeRequestScopeCurrent, subscribeRuntimeEndpointChanged, type RuntimeRequestScope } from '@/lib/runtime-switch';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { subscribeRestore } from './pageRestore';

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

/**
 * One item per id (smarty-code#1407: a list that carried an item twice showed two cards with one id). A repeated id is an
 * upsert: the newest version (by `updated`) takes the place of the first. Every list (each tab and the badge's all-state
 * read) passes through here, so the view, the badge and Steps all hold one item per id.
 */
const uniqueById = (items: InboxItem[]): InboxItem[] => {
  const byId = new Map<string, InboxItem>();
  for (const item of items) {
    const known = byId.get(item.id);
    if (!known || Date.parse(item.updated) >= Date.parse(known.updated)) byId.set(item.id, item);
  }
  return [...byId.values()];
};

/** Only http(s) links become anchors; anything else is shown as text. */
export const safeLink = (url: string) => { try { return ['https:', 'http:'].includes(new URL(url).protocol) ? url : null; } catch { return null; } };

export class InboxRequestError extends Error {
  constructor(message: string, readonly uncertain: boolean, readonly status?: number) { super(message); }
}
/** A read worth retrying: the network failed, the gateway is down (5xx) or busy (429). A 401/404 is an answer. */
export const isTransientInboxFailure = (error: Error): boolean => error instanceof InboxRequestError
  ? error.status === 429 || (error.status ?? 0) >= 500 : !(error instanceof z.ZodError);
const failure = async (response: Response) => {
  const body = z.object({ data: z.object({ message: z.string().optional(), code: z.string().optional() }).optional() }).safeParse(await response.json().catch(() => null));
  const unsupportedGuard = response.status === 501 && body.success && body.data.data?.code === 'smarty.inbox-guard-unavailable';
  return new InboxRequestError(body.success && body.data.data?.message || `Inbox request failed (${response.status})`, !unsupportedGuard && (response.status >= 500 || response.status === 408), response.status);
};

/**
 * The list for one tab; a 403 means this account has no inbox (the page shows no badge). `principal` (smarty-code#1476)
 * reads another principal's inbox, read only: the gateway answers 403 ("This inbox is not shared with you") unless the
 * signed-in person may see it. An answer for anyone but `principal` (a gateway that ignores `person=` and returns the
 * caller's own inbox) is not that inbox, so it counts as not shared.
 */
export async function loadInbox(state: InboxState | 'all', fetcher: Fetcher = runtimeFetch, principal?: string): Promise<InboxListResult> {
  const query = principal === undefined ? '' : `&person=${encodeURIComponent(principal)}`;
  // smarty-code#1480 review: never from the browser cache (another person's inbox, or your own).
  const response = await fetcher(`/api/inbox?state=${state}${query}`, { credentials: 'include', cache: 'no-store', headers: { accept: 'application/json' } });
  if (response.status === 403) return { available: false, items: [] };
  if (!response.ok) throw await failure(response);
  // A shared (read-only) answer carries `capabilities: {}`: it grants nothing (smarty-code#1476).
  const body = z.object({ items: z.array(z.json()), person: z.string().optional(),
    capabilities: z.object({ guardedReopen: z.boolean().optional() }).optional() }).parse(await response.json());
  if (principal !== undefined && body.person !== principal) return { available: false, items: [] };
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
  const result = { available: true, items: sortInboxItems(uniqueById(items)) };
  return state === 'all' ? { ...result, capabilities: { guardedReopen: body.capabilities?.guardedReopen ?? false }, invalidStepGroups } : result;
}

/** One write, with only the documented body fields (the gateway refuses others); returns the item after it. */
export async function actOnInboxItem(id: string, action: InboxAction, body: Record<string, string>, fetcher: Fetcher = runtimeFetch) {
  const response = await fetcher(`/api/inbox/${encodeURIComponent(id)}/${action}`, {
    method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw await failure(response);
  return z.object({ item: itemSchema }).parse(await response.json()).item;
}

export async function loadInboxItem(id: string, fetcher: Fetcher = runtimeFetch): Promise<InboxItem> {
  const response = await fetcher(`/api/inbox/${encodeURIComponent(id)}`, { credentials: 'include', cache: 'no-store', headers: { accept: 'application/json' } });
  if (!response.ok) throw await failure(response);
  return z.object({ item: itemSchema }).parse(await response.json()).item;
}

/**
 * smarty-code#1476: live changes to another principal's inbox (GET /inbox/events?person=, the same sharing rule as the
 * list). Each event only says "something changed": the caller reads the list again.
 */
export function watchSharedInbox(person: string, onChange: () => void): () => void {
  if (!globalThis.EventSource) return () => undefined;
  const source = new EventSource(getRuntimeUrlResolver().sse('/api/inbox/events', { person }), { withCredentials: true });
  source.onmessage = () => onChange();
  return () => source.close();
}

type Store = {
  snapshotScope: RuntimeRequestScope | null;
  available: boolean; openCount: number; p0Count: number; pageOpen: boolean; revision: number; items: InboxItem[]; snapshotValid: boolean; guardedReopen: boolean; invalidStepGroups: string[];
  setOpenItems: (available: boolean, items: InboxItem[]) => void; setPageOpen: (open: boolean) => void;
  setItems: (available: boolean, items: InboxItem[], details?: SnapshotDetails, scope?: RuntimeRequestScope) => void;
  recordItem: (item: InboxItem, scope?: RuntimeRequestScope) => void;
  invalidateSnapshot: () => void;
};
export const useInboxStore = create<Store>(set => ({
  snapshotScope: null, available: false, openCount: 0, p0Count: 0, pageOpen: false, revision: 0, items: [], snapshotValid: false, guardedReopen: false, invalidStepGroups: [],
  setOpenItems: (available, items) => set(s => ({ available, openCount: items.length,
    p0Count: items.filter(i => i.priority === 'p0').length, revision: s.revision + 1 })),
  setPageOpen: pageOpen => set({ pageOpen }),
  setItems: (available, items, details, scope = captureRuntimeRequestScope()) => set(s => {
    if (!isRuntimeRequestScopeCurrent(scope)) return s;
    const open = items.filter(i => inboxItemState(i) === 'open');
    return { snapshotScope: scope, available, items, snapshotValid: available, guardedReopen: details?.capabilities?.guardedReopen ?? false,
      invalidStepGroups: details?.invalidStepGroups ?? [], openCount: open.length, p0Count: open.filter(i => i.priority === 'p0').length, revision: s.revision + 1 };
  }),
  invalidateSnapshot: () => set({ snapshotValid: false }),
  recordItem: (item, scope = captureRuntimeRequestScope()) => set(s => {
    if (!isRuntimeRequestScopeCurrent(scope) || !s.snapshotScope || !isRuntimeRequestScopeCurrent(s.snapshotScope)) return s;
    const current = s.items.find(i => i.id === item.id);
    if (current && (Date.parse(current.updated) > Date.parse(item.updated) || JSON.stringify(current) === JSON.stringify(item))) return s;
    const items = [...s.items.filter(i => i.id !== item.id), item];
    // Retained history is not badge authority after an open-only fallback.
    if (!s.snapshotValid) return { items, revision: s.revision + 1 };
    const open = items.filter(i => inboxItemState(i) === 'open');
    return { items, snapshotValid: false, openCount: open.length, p0Count: open.filter(i => i.priority === 'p0').length, revision: s.revision + 1 };
  }),
}));

// Verified recovery also covers a same-origin person replacement without an App remount.
useAuthSessionStore.subscribe((state, before) => {
  if (state.recoveryGeneration !== before.recoveryGeneration) useInboxStore.getState().setItems(false, []);
});
// The normal path remains one all GET. A failed history read must not hide the ordinary open Inbox.
async function loadWatchSnapshot(load: () => Promise<InboxListResult>, current: () => boolean) {
  try { return { complete: true, result: await load() }; }
  catch {
    if (!current()) return null;
    return { complete: false, result: await loadInbox('open') };
  }
}
function applyWatchSnapshot(snapshot: NonNullable<Awaited<ReturnType<typeof loadWatchSnapshot>>>, scope: RuntimeRequestScope) {
  const store = useInboxStore.getState(), r = snapshot.result;
  if (snapshot.complete) {
    // A status/item receipt can be newer than a subsequent list projection. Preserve its version, not stale text.
    const receipts = new Map(store.items.map(item => [item.id, item]));
    const items = r.items.map(item => {
      const receipt = receipts.get(item.id);
      return store.snapshotScope && isRuntimeRequestScopeCurrent(store.snapshotScope) && receipt?.to === item.to
        && Date.parse(receipt.updated) > Date.parse(item.updated) ? receipt : item;
    });
    store.setItems(r.available, items, r, scope);
    return;
  }
  store.setOpenItems(r.available, r.items);
  store.invalidateSnapshot(); // Open is badge authority, never a silently reduced Steps snapshot.
}
let latestInboxRefresh = 0;
let pendingInboxRefresh: { scope: RuntimeRequestScope; revision: number; promise: Promise<void> } | null = null;
export const refreshInboxBadge = (options?: { reusePending?: boolean }): Promise<void> => {
  const scope = captureRuntimeRequestScope(), revision = useInboxStore.getState().revision;
  // Check status can join an unchanged receipt's all-state read, never a read predating a changed receipt.
  if (options?.reusePending && pendingInboxRefresh?.revision === revision && isRuntimeRequestScopeCurrent(pendingInboxRefresh.scope)) {
    return pendingInboxRefresh.promise;
  }
  const generation = ++latestInboxRefresh;
  const current = () => generation === latestInboxRefresh && isRuntimeRequestScopeCurrent(scope) && revision === useInboxStore.getState().revision;
  const promise = (async () => {
    try {
      const snapshot = await loadWatchSnapshot(() => loadInbox('all'), current);
      if (snapshot && current()) applyWatchSnapshot(snapshot, scope);
    } catch {
      // Keep text/progress visible, but a malformed or unavailable list cannot grant actionable group authority.
      if (current()) useInboxStore.getState().invalidateSnapshot();
    }
  })();
  const pending = { scope, revision, promise };
  pendingInboxRefresh = pending;
  void promise.then(() => { if (pendingInboxRefresh === pending) pendingInboxRefresh = null; });
  return promise;
};

/** Retries of a first load that failed (a network error, a gateway restart): 5 s, 15 s, then every 60 s. */
export const INBOX_RETRY_MS = [5_000, 15_000, 60_000];

/**
 * The badge and Steps share one all-state read on each existing watch event. If history fails, an open-only
 * fallback keeps the Inbox and this same subscription available, without granting Steps authority. Failed first
 * loads retry; a 403 (this account has no inbox) is an answer, and ends bootstrap.
 */
export function watchInbox(load = () => loadInbox('all'), retryMs = INBOX_RETRY_MS): () => void {
  let scope = captureRuntimeRequestScope(), run = 0;
  let source: EventSource | undefined, closed = false, timer: ReturnType<typeof setTimeout> | undefined;
  useInboxStore.getState().setItems(false, []);
  const attempt = (n: number) => {
    const revision = useInboxStore.getState().revision, requestScope = scope, mine = run;
    const current = () => !closed && mine === run && requestScope === scope && isRuntimeRequestScopeCurrent(requestScope);
    void loadWatchSnapshot(load, current).then(snapshot => {
      if (!snapshot || !current()) return;
      if (revision === useInboxStore.getState().revision) applyWatchSnapshot(snapshot, requestScope);
      if (!snapshot.result.available || !globalThis.EventSource) return;
      source = new EventSource(getRuntimeUrlResolver().sse('/api/inbox/events'), { withCredentials: true });
      source.onmessage = () => { if (!closed && requestScope === scope) void refreshInboxBadge(); };
    }, () => { if (current()) timer = setTimeout(() => attempt(n + 1), retryMs[Math.min(n, retryMs.length - 1)]); });
  };
  // A restart drops every earlier read (its run ends) and clears the store before reading again.
  const restart = () => {
    run += 1; source?.close(); source = undefined; clearTimeout(timer);
    scope = captureRuntimeRequestScope();
    useInboxStore.getState().setItems(false, []);
    attempt(0);
  };
  const unsubscribe = subscribeRuntimeEndpointChanged(restart);
  const unsubscribeAuth = useAuthSessionStore.subscribe((state, before) => {
    if (state.recoveryGeneration !== before.recoveryGeneration) restart();
  });
  // #574 security review: a tab brought back may now be another person's (an account switch in another tab): the store
  // clears at once, every pending read (badge refreshes included: the clear bumps the revision) is dropped, and it reads anew.
  const unsubscribeRestore = subscribeRestore(restart);
  attempt(0);
  return () => { closed = true; unsubscribe(); unsubscribeAuth(); unsubscribeRestore(); clearTimeout(timer); source?.close(); };
}
