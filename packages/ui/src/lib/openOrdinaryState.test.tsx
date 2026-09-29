import React, { act } from 'react';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { setSyncRefs } from '@/sync/sync-refs';
import { isGloballyUnavailable, isRetainedUnavailable, readOpenOrdinaryState } from './openOrdinaryState';
import { isHerdrEnded, showsViewOnly } from './herdrSession';

// openchamber#364 review (P1): the open session's directory sync row still says "connected, model M" when a managed
// listing leaves the session out. The retained-unavailable mark must win over that older row, re-render the composer's
// check, and give way (no keystroke) when a listing names the session again.
const initial = useGlobalSessionsStore.getState(), projects = useProjectsStore.getState(), ui = useSessionUIStore.getState();
afterEach(() => { useGlobalSessionsStore.setState(initial, true); useProjectsStore.setState(projects, true); useSessionUIStore.setState(ui, true); });

const dir = '/live-a';
const live: Session = { id: 'open-a', directory: dir, title: 't', slug: 'open-a', projectID: dir, version: '1', time: { created: 1, updated: 1 },
  ...{ ordinary: { generation: 'g1', sequence: 1, model: { providerID: 'p', modelID: 'm', name: 'M' }, thinkingLevel: 'high' } } };

// The managed listing's row is detailed (it carries the model) or, as the gateway's connected listings are, a lightweight
// summary without one (round 5): the mark alone must still change the global row, both ways.
const summary: Session = { id: 'open-a', directory: dir, title: 't', slug: 'open-a', projectID: dir, version: '1', time: { created: 1, updated: 1 } };
const listings: [string, Session][] = [['detailed', live], ['lightweight', summary]];
for (const [kind, listed] of listings) test(`the composer's check (${kind} listing row): an omitted listing makes the open session unavailable over its live directory row, and a listing brings it back`, async () => {
  // The directory sync store (child store) holds the open session's live row, as when it was opened.
  // A child-store manager with just what the sync reads use (the test's stand-in; the real one needs a live SDK).
  const store = { getState: () => ({ session: [live] }) };
  const manager: Parameters<typeof setSyncRefs>[1] = Object.assign(Object.create(null), { children: new Map([[dir, store]]), getState: () => store.getState() });
  setSyncRefs(Object.create(null), manager, dir);
  useProjectsStore.setState({ managedCatalogAdmitted: true, managedCatalogStatus: 'ready', managedRows: [{ id: 'a', worktree: dir }], managedProjects: [{ id: 'a', path: dir }] });
  useGlobalSessionsStore.getState().applyManagedSessions([listed], useGlobalSessionsStore.getState().mutationRevision, new Set([dir]));
  useSessionUIStore.setState({ currentSessionId: 'open-a', currentSessionDirectory: dir });

  const seen: (string | null)[] = [];
  // As the composer (ChatInput) reads it: the observed global mark, then the sync rows.
  const Probe = () => {
    const retained = useGlobalSessionsStore((state) => isRetainedUnavailable(state.entityById.get('open-a')));
    seen.push(readOpenOrdinaryState('open-a', dir, retained)?.model?.name ?? null); return null;
  };
  const win = new Window({ url: 'http://localhost' });
  const values = { window: win, document: win.document, navigator: win.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Probe />));
    expect(seen.at(-1)).toBe('M'); // connected: Send on
    // One listing leaves it out (its project stays): unavailable, although the directory row still says "M".
    await act(async () => { useGlobalSessionsStore.getState().applyManagedSessions([], useGlobalSessionsStore.getState().mutationRevision, new Set([dir])); });
    expect(useSessionUIStore.getState().currentSessionId).toBe('open-a'); // still open
    expect(seen.at(-1)).toBeNull(); // re-rendered: Send off, with its reason
    // A listing names it again: back, with no keystroke.
    await act(async () => { useGlobalSessionsStore.getState().applyManagedSessions([listed], useGlobalSessionsStore.getState().mutationRevision, new Set([dir])); });
    expect(seen.at(-1)).toBe('M');
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    await win.happyDOM.close();
  }
});

// smarty-code#811 on 3.53 (installed): the managed listing's row said herdrState 'ended' (the header followed it), but the
// open session's directory row missed the stream update (the directory stream closes whenever a row leaves) and its refresh
// failed. The composer and the View only banner read that directory row, so the page stayed live after the tab closed.
test('an ended global row makes the open session View only with Send off, over its live directory row', async () => {
  const store = { getState: () => ({ session: [live] }) };
  const manager: Parameters<typeof setSyncRefs>[1] = Object.assign(Object.create(null), { children: new Map([[dir, store]]), getState: () => store.getState() });
  setSyncRefs(Object.create(null), manager, dir);
  useProjectsStore.setState({ managedCatalogAdmitted: true, managedCatalogStatus: 'ready', managedRows: [{ id: 'a', worktree: dir }], managedProjects: [{ id: 'a', path: dir }] });
  useGlobalSessionsStore.getState().applyManagedSessions([live], useGlobalSessionsStore.getState().mutationRevision, new Set([dir]));
  useSessionUIStore.setState({ currentSessionId: 'open-a', currentSessionDirectory: dir });
  const seen: { model: string | null; viewOnly: boolean }[] = [];
  // As ChatInput (Send) and ChatContainer (the banner) read it: the observed global row, then the directory row.
  const Probe = () => {
    const unavailable = useGlobalSessionsStore((state) => isGloballyUnavailable(state.entityById.get('open-a')));
    const globalEnded = useGlobalSessionsStore((state) => isHerdrEnded(state.entityById.get('open-a')));
    const directoryRow = store.getState().session[0]!;
    seen.push({ model: readOpenOrdinaryState('open-a', dir, unavailable)?.model?.name ?? null, viewOnly: showsViewOnly(false, directoryRow, globalEnded) });
    return null;
  };
  const win = new Window({ url: 'http://localhost' });
  const values = { window: win, document: win.document, navigator: win.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Probe />));
    expect(seen.at(-1)).toEqual({ model: 'M', viewOnly: false }); // live
    // The listing names it ended (its tab closed); the directory row is not updated.
    const ended: Session = { ...summary, title: 'Pi session', ...{ herdrState: 'ended' } };
    await act(async () => { useGlobalSessionsStore.getState().applyManagedSessions([ended], useGlobalSessionsStore.getState().mutationRevision, new Set([dir])); });
    expect(seen.at(-1)).toEqual({ model: null, viewOnly: true }); // Send off; View only, as the gateway said
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    await win.happyDOM.close();
  }
});
