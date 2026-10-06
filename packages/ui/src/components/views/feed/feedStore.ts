// smarty-code#1407: whether the Feed page is open, and the reply typed for each org agent session (in memory: it
// survives closing and reopening the page, not a reload).
import { create } from 'zustand';
import { useInboxStore } from '@/lib/smartyInbox';
import { getRuntimeKey } from '@/lib/runtime-switch';

type FeedStore = {
  pageOpen: boolean;
  drafts: Readonly<Record<string, string>>;
  setPageOpen: (open: boolean) => void;
  setDraft: (sessionId: string, text: string) => void;
};

const draftKey = (sessionId: string) => `${getRuntimeKey()}\u0000${sessionId}`;

export const useFeedStore = create<FeedStore>(set => ({
  pageOpen: false,
  drafts: {},
  setPageOpen: pageOpen => set({ pageOpen }),
  setDraft: (sessionId, text) => set(state => ({ drafts: { ...state.drafts, [draftKey(sessionId)]: text } })),
}));

export const useFeedDraft = (sessionId: string) => useFeedStore(state => state.drafts[draftKey(sessionId)] ?? '');
export const readFeedDraft = (sessionId: string) => useFeedStore.getState().drafts[draftKey(sessionId)] ?? '';

/** The Feed and the Inbox page share the chat area: opening one replaces the other. */
export function openFeedPage(): void {
  useInboxStore.getState().setPageOpen(false);
  useFeedStore.getState().setPageOpen(true);
}
useInboxStore.subscribe((state, before) => {
  if (state.pageOpen && !before.pageOpen) useFeedStore.getState().setPageOpen(false);
});
