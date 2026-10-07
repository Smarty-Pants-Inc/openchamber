// smarty-code#1407: which view fills the app (a Smarty, or the old Smarty Code view behind the nav's bottom button),
// which Smarties the person may see, which one is selected, and the message typed for each (in memory: it survives
// switching views, not a reload). Every load lands on the person's own Smarty: the old view opens only from the bottom
// button, for that visit, and is never restored from memory.
import { create } from 'zustand';
import { useInboxStore } from '@/lib/smartyInbox';
import { captureRuntimeRequestScope, getRuntimeKey, isRuntimeRequestScopeCurrent, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { loadSmarties, type SmartiesResult } from '@/lib/smarties';

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
  /** A send that failed: its text and client ID, so sending the same text again is deduped by the gateway. */
  failedSends: Readonly<Record<string, FailedSend>>;
  /**
   * Opens the Smarty view. Closing requests (`false`) are ignored: the app's automatic closes (a session restored on
   * load, a draft opening) must not leave the Smarty view. Only `showClassic` (the bottom button) leaves it.
   */
  setPageOpen: (open: boolean) => void;
  showClassic: () => void;
  selectSmarty: (id: string) => void;
  setSmarties: (smarties: SmartiesState) => void;
  setDraftAt: (key: string, text: string) => void;
  setFailedSend: (key: string, failed: FailedSend | null) => void;
};
export type FailedSend = { text: string; clientId: string; at: number };

const isPageOpen = (view: View, smarties: SmartiesState) => view === 'smarty' && smarties.state !== 'unavailable';
export const draftKey = (smartyId: string) => `${getRuntimeKey()}\u0000${smartyId}`;

export const useFeedStore = create<FeedStore>(set => {
  const smarties: SmartiesState = { state: 'loading' };
  const toView = (view: View) => set(state => ({ view, pageOpen: isPageOpen(view, state.smarties) }));
  return {
    view: 'smarty', smarties, selectedId: null, pageOpen: isPageOpen('smarty', smarties), drafts: {}, failedSends: {},
    setPageOpen: open => { if (open) toView('smarty'); },
    showClassic: () => toView('classic'),
    selectSmarty: id => set(state => ({ view: 'smarty', selectedId: id, pageOpen: isPageOpen('smarty', state.smarties) })),
    setSmarties: next => set(state => {
      // The own Smarty (listed first) is the default; a selection the server no longer lists falls back to it.
      const ids = next.state === 'ready' ? next.smarties.map(smarty => smarty.id) : [];
      const selectedId = next.state !== 'ready' ? state.selectedId : state.selectedId && ids.includes(state.selectedId) ? state.selectedId : ids[0] ?? null;
      return { smarties: next, selectedId, pageOpen: isPageOpen(state.view, next) };
    }),
    setDraftAt: (key, text) => set(state => ({ drafts: { ...state.drafts, [key]: text } })),
    setFailedSend: (key, failed) => set(state => {
      const failedSends = { ...state.failedSends };
      if (failed) failedSends[key] = failed; else delete failedSends[key];
      return { failedSends };
    }),
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
