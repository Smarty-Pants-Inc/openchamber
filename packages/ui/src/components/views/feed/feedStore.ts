// smarty-code#1407: which view fills the app (a Smarty, or the old Smarty Code view behind the nav's bottom button),
// which Smarties the person may see, which one is selected, and the message typed for each (in memory: it survives
// switching views, not a reload). Every load lands on the person's own Smarty: the old view opens only from the bottom
// button, for that visit, and is never restored from memory.
import React from 'react';
import { create } from 'zustand';
import { useInboxStore } from '@/lib/smartyInbox';
import { captureRuntimeRequestScope, getRuntimeKey, isRuntimeRequestScopeCurrent, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { loadSmarties, type SmartiesResult, type SmartyActivity } from '@/lib/smarties';

export type SmartiesState = { state: 'loading' } | { state: 'failed' } | SmartiesResult;
type View = 'smarty' | 'classic';

type FeedStore = {
  view: View;
  smarties: SmartiesState;
  selectedId: string | null;
  /** The Smarty view fills the chat area: the person is in it and this server has Smarties (or is still saying). */
  pageOpen: boolean;
  /** Keyed by runtime and Smarty (draftKey), so a late answer from one server never writes into another's draft. */
  drafts: Readonly<Record<string, string>>;
  /**
   * Sends that failed, per draft key: each keeps its own text and client ID, apart from the draft, so "Send again"
   * retries exactly that message (the gateway dedupes the ID) and later typing never merges into it.
   */
  failedSends: Readonly<Record<string, readonly FailedSend[]>>;
  /**
   * Sent messages shown at once as the owner's lines, marked as sending, per draft key. Each stays until the feed's own
   * block for it arrives (the owner's line with the same text that was not in the feed at send time), or until it fails.
   */
  pendingSends: Readonly<Record<string, readonly PendingSend[]>>;
  /**
   * Opens the Smarty view. Closing requests (`false`) are ignored: the app's automatic closes (a session restored on
   * load, a draft opening) must not leave the Smarty view. Only `showClassic` (the bottom button) leaves it.
   */
  setPageOpen: (open: boolean) => void;
  showClassic: () => void;
  selectSmarty: (id: string) => void;
  setSmarties: (smarties: SmartiesState) => void;
  /** #1490: one Smarty's activity, from its open stream. */
  setActivity: (id: string, activity: SmartyActivity) => void;
  setDraftAt: (key: string, text: string) => void;
  addFailedSend: (key: string, failed: FailedSend) => void;
  removeFailedSend: (key: string, clientId: string) => void;
  addPendingSend: (key: string, pending: PendingSend) => void;
  removePendingSends: (key: string, clientIds: readonly string[]) => void;
};
export type FailedSend = { text: string; clientId: string; at: number };
/** `known`: ids of the owner's blocks with this text already in the feed when it was sent (they are not its echo). */
export type PendingSend = FailedSend & { known: readonly string[] };

const isPageOpen = (view: View, smarties: SmartiesState) => view === 'smarty' && smarties.state !== 'unavailable';
/** The owner's own feed line: "you", as the backfill and the gateway write it, or the owner's id. */
export const isOwnerLine = (block: { author: string }, owner: string) => block.author === 'you' || block.author === owner;
export const draftKey = (smartyId: string) => `${getRuntimeKey()}\u0000${smartyId}`;

export const useFeedStore = create<FeedStore>(set => {
  const smarties: SmartiesState = { state: 'loading' };
  const toView = (view: View) => set(state => ({ view, pageOpen: isPageOpen(view, state.smarties) }));
  return {
    view: 'smarty', smarties, selectedId: null, pageOpen: isPageOpen('smarty', smarties), drafts: {}, failedSends: {}, pendingSends: {},
    setPageOpen: open => { if (open) toView('smarty'); },
    showClassic: () => toView('classic'),
    selectSmarty: id => set(state => ({ view: 'smarty', selectedId: id, pageOpen: isPageOpen('smarty', state.smarties) })),
    setSmarties: next => set(state => {
      // The own Smarty (listed first) is the default; a selection the server no longer lists falls back to it.
      const ids = next.state === 'ready' ? next.smarties.map(smarty => smarty.id) : [];
      const selectedId = next.state !== 'ready' ? state.selectedId : state.selectedId && ids.includes(state.selectedId) ? state.selectedId : ids[0] ?? null;
      return { smarties: next, selectedId, pageOpen: isPageOpen(state.view, next) };
    }),
    setActivity: (id, activity) => set(state => state.smarties.state !== 'ready' ? {}
      : { smarties: { ...state.smarties, smarties: state.smarties.smarties.map(smarty => smarty.id === id ? { ...smarty, activity } : smarty) } }),
    setDraftAt: (key, text) => set(state => ({ drafts: { ...state.drafts, [key]: text } })),
    addFailedSend: (key, failed) => set(state => ({ failedSends: { ...state.failedSends, [key]: [...(state.failedSends[key] ?? []), failed] } })),
    removeFailedSend: (key, clientId) => set(state => ({ failedSends: { ...state.failedSends, [key]: (state.failedSends[key] ?? []).filter(item => item.clientId !== clientId) } })),
    addPendingSend: (key, pending) => set(state => ({ pendingSends: { ...state.pendingSends, [key]: [...(state.pendingSends[key] ?? []), pending] } })),
    removePendingSends: (key, clientIds) => set(state => ({ pendingSends: { ...state.pendingSends, [key]: (state.pendingSends[key] ?? []).filter(item => !clientIds.includes(item.clientId)) } })),
  };
});

export const readDraftAt = (key: string) => useFeedStore.getState().drafts[key] ?? '';

let pending: Promise<void> | null = null;
/** One read of the Smarties list at a time; a failure is shown (with Try again), never read as "no Smarties". */
export function ensureSmartiesLoaded(load: () => Promise<SmartiesResult> = loadSmarties, force = false): Promise<void> {
  const store = useFeedStore.getState();
  if (pending || (!force && store.smarties.state !== 'loading')) return pending ?? Promise.resolve();
  if (force) store.setSmarties({ state: 'loading' });
  const scope = captureRuntimeRequestScope();
  const request = load().then(result => { if (isRuntimeRequestScopeCurrent(scope)) useFeedStore.getState().setSmarties(result); },
    () => { if (isRuntimeRequestScopeCurrent(scope)) useFeedStore.getState().setSmarties({ state: 'failed' }); })
    .finally(() => { if (pending === request) pending = null; });
  pending = request;
  return request;
}
/** #1490: how often a shown Smarties list re-reads its activity (the open Smarty's also comes live on its stream). */
export const REFRESH_MS = 15_000;
/** A quiet re-read of a ready list: no loading state. A failed read keeps the list but marks each status unknown (its
 * last activity stays): an old answer is never shown as current. */
let refreshing: Promise<void> | undefined;
export function refreshSmarties(load: () => Promise<SmartiesResult> = loadSmarties): Promise<void> {
  if (pending || useFeedStore.getState().smarties.state !== 'ready') return pending ?? Promise.resolve();
  // Single flight: a slow re-read is never overlapped, so an older answer cannot land after a newer one.
  if (refreshing) return refreshing;
  const scope = captureRuntimeRequestScope();
  return refreshing = load().then(result => { if (isRuntimeRequestScopeCurrent(scope)) useFeedStore.getState().setSmarties(result); }, () => {
    const now = useFeedStore.getState().smarties;
    if (!isRuntimeRequestScopeCurrent(scope) || now.state !== 'ready') return;
    useFeedStore.getState().setSmarties({ ...now, smarties: now.smarties.map(smarty => smarty.activity
      ? { ...smarty, activity: { ...smarty.activity, state: 'unknown', startedAt: null } } : smarty) });
  }).finally(() => { refreshing = undefined; });
}
let refreshers = 0, refreshTimer: ReturnType<typeof setInterval> | undefined;
/** Mounted by the nav and the view: one timer however many are shown, paused while the page is hidden. */
export function useSmartiesRefresh(load?: () => Promise<SmartiesResult>): void {
  React.useEffect(() => {
    if (refreshers++ === 0) refreshTimer = setInterval(() => { if (globalThis.document?.visibilityState !== 'hidden') void refreshSmarties(load); }, REFRESH_MS);
    return () => { if (--refreshers === 0) clearInterval(refreshTimer); };
  }, [load]);
}
subscribeRuntimeEndpointChanged(() => { pending = null; useFeedStore.getState().setSmarties({ state: 'loading' }); void ensureSmartiesLoaded(); });

/** The Smarty view and the Inbox page share the chat area: opening the inbox page replaces it. */
export function openFeedPage(): void {
  useInboxStore.getState().setPageOpen(false);
  useFeedStore.getState().setPageOpen(true);
}
// The Inbox page is the old view's: opening it (from the old view's header) shows the old view.
useInboxStore.subscribe((state, before) => {
  if (state.pageOpen && !before.pageOpen) useFeedStore.getState().showClassic();
});

/** The app's top bar while a Smarty fills the chat area: the Smarty's name (blank until known); null otherwise. */
export const smartyHeaderTitle = (state: Pick<FeedStore, 'pageOpen' | 'smarties' | 'selectedId'>): string | null => {
  if (!state.pageOpen) return null;
  const list = state.smarties.state === 'ready' ? state.smarties.smarties : [];
  return list.find(smarty => smarty.id === state.selectedId)?.label ?? '';
};
