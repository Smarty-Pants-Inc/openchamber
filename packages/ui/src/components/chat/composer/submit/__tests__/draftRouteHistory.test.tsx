import { afterEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setTimeout as sleep } from 'node:timers/promises';
import { mountedNativeComposer } from './nativeComposer.fixture';
import { acceptedView, deferred, directory, session } from '@/sync/native-draft-fixture';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import * as managedRefresh from '@/lib/managed-project-refresh';
import * as globalSessions from '@/stores/useGlobalSessionsStore';
import { useRouter } from '@/hooks/useRouter';
import { readLastActiveSession } from '@/sync/last-session-cache';
import { readChatDraft } from '@/lib/chatDraftPersistence';
import { FleetViewOnlyBanner } from '@/components/chat/FleetViewOnlyBanner';
import { isHerdrEnded, showsViewOnly } from '@/lib/herdrSession';
import { useHumanAuth } from '@/lib/human-auth';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import type { SessionMessageLoader } from '@/sync/session-message-loader';
import { resetEmbeddedSessionChatCache } from '@/components/layout/contextPanelEmbeddedChat';

const { ChatInput } = await import('@/components/chat/ChatInput');

// smarty-code#113 (OC#213 review): a draft action cancels a pending session restore at once, address bar included, so
// a reload before the restore settles shows the draft; leaving a shown session keeps its history entry.
let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
let root: Root | undefined;
afterEach(async () => { await act(async () => { root?.unmount(); }); root = undefined; await mounted?.dispose(); mounted = undefined; });
function Router() { useRouter(); return null; }
const settle = () => sleep(0);
const shown = () => new URL(window.location.href).searchParams.get('session');
const mountRouter = async (c: NonNullable<typeof mounted>) => {
  const host = document.createElement('div'); c.dom.container.appendChild(host);
  root = createRoot(host); root.render(<Router />); await settle();
};

// Use the same stopped-owner presentation decision as ChatContainer, without mounting
// unrelated timeline/sidebar panels. The router, selection, loader, banner and editor are real.
function ReloadOwnerComposer({ loader }: { loader: SessionMessageLoader }) {
  const id = useSessionUIStore(state => state.currentSessionId);
  const owner = useGlobalSessionsStore(state => id ? state.entityById.get(id) : undefined);
  const target = React.useMemo(() => ({ directory, sessionID: id ?? '' }), [id]);
  const subscribe = React.useCallback((notify: () => void) => loader.subscribe(target, notify), [loader, target]);
  const snapshot = React.useCallback(() => loader.getSnapshot(target), [loader, target]);
  const history = React.useSyncExternalStore(subscribe, snapshot, snapshot);
  return <>
    <button type="button" onClick={() => useSessionUIStore.getState().openNewSessionDraft()}>New session</button>
    {showsViewOnly(history.readOnly, owner) ? <FleetViewOnlyBanner ended={isHerdrEnded(owner)} /> : <ChatInput />}
  </>;
}

for (const stopped of [true, false]) test(`mounted ${stopped ? 'stopped' : 'healthy'} owner reload: one New session click clears the old route without replay`, async () => {
  const initialAuth = useHumanAuth.getState();
  const initialAuthSession = useAuthSessionStore.getState();
  useHumanAuth.setState({ enabled: true });
  useAuthSessionStore.getState().markAuthenticated();
  let ended = false;
  const newId = '98765432-1234-4234-9234-012345678901';
  const c = mounted = await mountedNativeComposer(true, undefined, undefined,
    fixture => <ReloadOwnerComposer loader={fixture.loader} />,
    fixture => {
      // Synthetic HTTP is the only replaced boundary. Discovery, global loading,
      // route restoration and message loading execute their production code.
      spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        fixture.requests.push(request.clone());
        const url = new URL(request.url);
        if (url.hostname !== 'synthetic.invalid') throw new Error('Unexpected reload test network target');
        if (url.pathname.endsWith('/project')) return Response.json([{ id: 'a', worktree: directory }],
          { headers: { 'x-smarty-code-catalog': 'managed-v1' } });
        if (url.pathname.endsWith('/experimental/session')) return Response.json([{ ...session, herdrState: ended ? 'ended' : 'working' }]);
        if (url.pathname.endsWith('/session/status')) return Response.json({});
        if (url.pathname.endsWith('/fs/home')) return Response.json({ home: '/fixture-home', chatsRoot: '/fixture-chats' });
        if (url.pathname.endsWith('/config/sidebar-view')) return Response.json({
          owner: { issuer: 'fixture', subject: 'reload-person' }, projects: {}, groups: {},
        });
        if (url.pathname.endsWith('/global/health')) return fixture.handlers.health();
        if (url.pathname.endsWith('/git/worktrees/bootstrap-status')) return fixture.handlers.bootstrap();
        if (url.pathname.endsWith('/session') && request.method === 'POST') return Response.json({
          ...session, id: newId, nativeCreation: { ...session.nativeCreation, inputReady: true },
        });
        if (url.pathname.endsWith('/message') && request.method === 'GET') return Response.json([], {
          headers: ended && url.pathname.includes(session.id)
            ? { 'x-smarty-read-only': '1' } : { 'x-smarty-ordinary-view': acceptedView },
        });
        if (url.pathname.endsWith('/prompt_async')) return fixture.handlers.prompt(request);
        if (url.pathname.endsWith('/config/settings')) return fixture.handlers.settings();
        if (url.pathname.endsWith('/snippets/expand')) return fixture.handlers.snippet();
        if (url.pathname.endsWith('/magic-prompts')) return fixture.handlers.magic();
        if (url.pathname.endsWith('/config/providers')) return Response.json({ providers: [], default: {} });
        if (url.pathname.endsWith('/openchamber/models-metadata')) return Response.json({});
        if (url.pathname.endsWith('/agent')) return Response.json([]);
        return new Response(null, { status: 404 });
      });
      useProjectsStore.getState().resetManagedCatalog();
      useGlobalSessionsStore.getState().resetForRuntimeSwitch();
      useSessionUIStore.setState(state => ({ currentSessionId: null, currentSessionDirectory: null,
        newSessionDraft: { ...state.newSessionDraft, open: false }, nativeDraftCreations: new Map() }));
      window.history.replaceState(null, '', `/?session=${session.id}`);
    });
  try {
    await act(async () => { await mountRouter(c); await settle(); });
    const target = { directory, sessionID: session.id };
    await act(async () => { await c.loader.ensure(target); await settle(); });
    expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
    expect(shown()).toBe(session.id);
    const unsent = 'Saved input owned only by the previous session';
    await c.replace(unsent);
    const reloadURL = window.location.href;
    const beforeReloadReads = c.requests.filter(r => new URL(r.url).pathname.endsWith('/message')).length;
    await act(async () => { root?.unmount(); root = undefined; });
    ended = stopped;
    await act(async () => {
      // New component lifetimes and empty selection/discovery/message state,
      // while the browser address and durable drafts survive as on page reload.
      c.loader.invalidateDirectory(directory);
      c.children.disposeAll();
      useProjectsStore.getState().resetManagedCatalog();
      useGlobalSessionsStore.getState().resetForRuntimeSwitch();
      useSessionUIStore.setState(state => ({ currentSessionId: null, currentSessionDirectory: null,
        newSessionDraft: { ...state.newSessionDraft, open: false }, nativeDraftCreations: new Map() }));
      window.history.replaceState(null, '', reloadURL);
      c.remount();
      await mountRouter(c); await settle();
    });
    await act(async () => { await c.loader.ensure(target); await settle(); });
    expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(directory);
    expect(shown()).toBe(session.id);
    expect(c.requests.filter(r => new URL(r.url).pathname.endsWith('/message')).length).toBeGreaterThan(beforeReloadReads);
    expect(c.loader.getSnapshot(target).readOnly).toBe(stopped);
    const notice = c.dom.container.querySelector('[data-testid="fleet-view-only"]');
    expect(Boolean(notice)).toBe(stopped);
    if (stopped) expect(notice?.textContent).toContain('ended');
    else expect(c.text()).toBe(unsent);
    expect(c.creates()).toHaveLength(0);
    expect(c.prompts()).toHaveLength(0);
    const push = spyOn(window.history, 'pushState');
    try {
      await act(async () => {
        c.dom.container.querySelector<HTMLButtonElement>('button')?.click();
        await settle();
      });
      // Check the old query before any second typing, creation or Send.
      expect(shown()).toBeNull();
      expect(useSessionUIStore.getState().currentSessionId).toBeNull();
      expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true);
      expect(readLastActiveSession(c.runtimeA)).toBeNull();
      expect(c.text()).toBe('');
      expect(readChatDraft({ runtimeKey: c.runtimeA, directory, sessionId: session.id }).text).toBe(unsent);
      expect(c.creates()).toHaveLength(0);
      expect(c.prompts()).toHaveLength(0);
      expect(push.mock.calls.map(call => String(call[2]))).toEqual(['/']);
      console.log('RELOAD_NEW_SESSION', JSON.stringify({ stopped, readOnly: c.loader.getSnapshot(target).readOnly,
        stoppedNotice: Boolean(notice), queryAfterNew: shown(), pushes: push.mock.calls.map(call => String(call[2])),
        oldSavedInput: readChatDraft({ runtimeKey: c.runtimeA, directory, sessionId: session.id }).text === unsent,
        automaticCreates: c.creates().length, automaticPrompts: c.prompts().length }));
      await c.replace('One new prompt, never replay the saved input');
      await c.submit();
      expect(c.creates()).toHaveLength(1);
      expect(c.prompts()).toHaveLength(1);
      expect(new URL(c.prompts()[0].url).pathname).toContain(newId);
      expect(new URL(c.prompts()[0].url).pathname).not.toContain(session.id);
      expect(JSON.stringify(await c.prompts()[0].clone().json())).not.toContain(unsent);
      expect(useSessionUIStore.getState().currentSessionId).toBe(newId);
      expect(shown()).toBe(newId);
    } finally { push.mockRestore(); }
  } finally {
    await act(async () => {
      useHumanAuth.setState(initialAuth, true);
      useAuthSessionStore.setState(initialAuthSession, true);
    });
  }
});

for (const context of ['vscode', 'embedded'] as const) test(`${context} New session preserves the fixed URL`, async () => {
  const c = mounted = await mountedNativeComposer(true);
  const config = Object.getOwnPropertyDescriptor(window, '__VSCODE_CONFIG__');
  try {
    await act(async () => {
      if (context === 'vscode') Object.defineProperty(window, '__VSCODE_CONFIG__', { value: {}, configurable: true });
      useGlobalSessionsStore.getState().applySnapshot([session], [], 'ready');
      window.history.replaceState(null, '', context === 'embedded'
        ? `/?ocPanel=session-chat&sessionId=${session.id}&directory=%2Fnative-project-a&readOnly=1`
        : `/?session=${session.id}`);
      // An iframe's initial selection is App-owned; useRouter preserves its URL.
      if (context === 'embedded') useSessionUIStore.getState().setCurrentSession(session.id, directory);
      resetEmbeddedSessionChatCache(); // A fresh document has a fresh embedded-context cache.
      await mountRouter(c);
    });
    expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
    const initialURL = window.location.href;
    const push = spyOn(window.history, 'pushState');
    const replace = spyOn(window.history, 'replaceState');
    try {
      await act(async () => { useSessionUIStore.getState().openNewSessionDraft(); await settle(); });
      expect(useSessionUIStore.getState().currentSessionId).toBeNull();
      expect(window.location.href).toBe(initialURL);
      expect(push).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
    } finally { push.mockRestore(); replace.mockRestore(); }
  } finally {
    await act(async () => { root?.unmount(); root = undefined; });
    resetEmbeddedSessionChatCache();
    if (config) Object.defineProperty(window, '__VSCODE_CONFIG__', config);
    else Reflect.deleteProperty(window, '__VSCODE_CONFIG__');
  }
});

for (const action of ['explicit', 'typed'] as const) test(`a draft action while a session restore is pending drops its ?session= at once: ${action}`, async () => {
  const c = mounted = await mountedNativeComposer(true);
  const held = deferred<void>();
  const refresh = spyOn(managedRefresh, 'refreshManagedProjects').mockImplementation(() => held.promise);
  try {
    await act(async () => {
      useProjectsStore.setState({ managedCatalogAdmitted: true, managedCatalogStatus: 'unknown', managedProjects: null, managedRows: null });
      useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, nativeDraftCreations: new Map() });
      window.history.replaceState(null, '', `/?session=${session.id}`);
      await mountRouter(c);
    });
    expect(shown()).toBe(session.id);
    await act(async () => {
      if (action === 'explicit') useSessionUIStore.getState().openNewSessionDraft();
      else await c.replace('Unsent draft');
      await settle();
    });
    // Still pending: a reload now must not find the session anywhere.
    expect(shown()).toBeNull();
    expect(readLastActiveSession(c.runtimeA)).toBeNull();
  } finally { held.resolve(); refresh.mockRestore(); }
});

test('leaving a shown session for New session keeps its history entry: Back returns to it', async () => {
  const c = mounted = await mountedNativeComposer(true);
  const other = { ...session, id: '98765432-1234-4234-9234-012345678901' };
  await act(async () => {
    useProjectsStore.getState().applyManagedCatalog([{ id: 'a', worktree: directory }]);
    useGlobalSessionsStore.getState().applySnapshot([session, other], [], 'ready');
    useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, nativeDraftCreations: new Map() });
    window.history.replaceState(null, '', '/');
    await mountRouter(c);
  });
  const entries: (string | null)[] = [];
  const push = spyOn(window.history, 'pushState');
  try {
    for (const id of [session.id, other.id]) {
      await act(async () => { useSessionUIStore.getState().setCurrentSession(id, directory); await settle(); });
      entries.push(shown());
    }
    await act(async () => { useSessionUIStore.getState().openNewSessionDraft(); await settle(); });
    expect(entries).toEqual([session.id, other.id]);
    expect(shown()).toBeNull();
    // The draft was pushed as its own entry, so the previous one (Back) is still the session just left.
    expect(push.mock.calls.map(call => String(call[2]))).toEqual([`/?session=${session.id}`, `/?session=${other.id}`, '/']);
  } finally { push.mockRestore(); }
});

test('a settled managed route leaves New in history and on remount, with unsent text owned by A', async () => {
  const c = mounted = await mountedNativeComposer(true);
  await c.replace(''); // The fixture's starting draft must not seed the next New composer.
  await act(async () => {
    useProjectsStore.getState().applyManagedCatalog([{ id: 'a', worktree: directory }]);
    useGlobalSessionsStore.getState().applySnapshot([session], [], 'ready');
    useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, nativeDraftCreations: new Map() });
    window.history.replaceState(null, '', `/?session=${session.id}`);
    await mountRouter(c);
  });
  // Only the actual mounted router selects A, after its subscription starts with null.
  expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
  expect(useSessionUIStore.getState().currentSessionDirectory).toBe(directory);
  expect(shown()).toBe(session.id);
  expect(readLastActiveSession(c.runtimeA)?.sessionId).toBe(session.id);
  const newer = 'Newer unsent text owned by session A';
  await c.replace(newer);
  expect(c.text()).toBe(newer);
  const push = spyOn(window.history, 'pushState');
  try {
    await act(async () => { useSessionUIStore.getState().openNewSessionDraft(); await settle(); });
    expect(c.text()).toBe('');
    expect(useSessionUIStore.getState().currentSessionId).toBeNull();
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true);
    expect(useSessionUIStore.getState().newSessionDraft.selectedProjectId).toBe('a');
    expect(useSessionUIStore.getState().newSessionDraft.directoryOverride).toBe(directory);
    expect(readLastActiveSession(c.runtimeA)).toBeNull();
    expect(readChatDraft({ runtimeKey: c.runtimeA, directory, sessionId: session.id }).text).toBe(newer);
    expect(c.prompts()).toHaveLength(0);
    // A remains the preceding history entry; New must push its own address for Back.
    expect({ query: shown(), pushes: push.mock.calls.map(call => String(call[2])) })
      .toEqual({ query: null, pushes: ['/'] });
    const newURL = window.location.href;
    await act(async () => {
      root?.unmount(); root = undefined;
      useSessionUIStore.setState(state => ({ currentSessionId: null, currentSessionDirectory: null,
        newSessionDraft: { ...state.newSessionDraft, open: false }, nativeDraftCreations: new Map() }));
      window.history.replaceState(null, '', newURL);
      c.remount();
      await mountRouter(c);
    });
    expect(useSessionUIStore.getState().currentSessionId).toBeNull();
    await act(async () => { useSessionUIStore.getState().openNewSessionDraft({ automatic: true }); await settle(); });
    expect(useSessionUIStore.getState().currentSessionId).toBeNull();
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true);
    expect(useSessionUIStore.getState().newSessionDraft.selectedProjectId).toBe('a');
    expect(useSessionUIStore.getState().newSessionDraft.directoryOverride).toBe(directory);
    expect(c.prompts()).toHaveLength(0);
    expect(c.text()).toBe('');
    expect(shown()).toBeNull();
    expect(readLastActiveSession(c.runtimeA)).toBeNull();
    await act(async () => {
      root?.unmount(); root = undefined;
      window.history.replaceState(null, '', `/?session=${session.id}`);
      await mountRouter(c);
    });
    expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
    expect(shown()).toBe(session.id);
    expect(c.text()).toBe(newer);
    expect(c.prompts()).toHaveLength(0);
  } finally { push.mockRestore(); }
});

test('a stock route restore that already shows its session, still loading: New session drops ?session= at once', async () => {
  const c = mounted = await mountedNativeComposer(true);
  const held = deferred<void>();
  const load = spyOn(globalSessions, 'ensureGlobalSessionsLoaded').mockImplementation(async () => {
    await held.promise; return { activeSessions: [session], archivedSessions: [] };
  });
  try {
    await act(async () => {
      useProjectsStore.setState({ managedCatalogAdmitted: false, managedCatalogStatus: 'stock', managedProjects: null, managedRows: null });
      useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, nativeDraftCreations: new Map() });
      window.history.replaceState(null, '', `/?session=${session.id}`);
      await mountRouter(c);
    });
    expect(useSessionUIStore.getState().currentSessionId).toBe(session.id); // Shown before its snapshot arrives.
    await act(async () => { useSessionUIStore.getState().openNewSessionDraft(); await settle(); });
    expect(shown()).toBeNull();
    expect(readLastActiveSession(c.runtimeA)).toBeNull();
    await act(async () => { held.resolve(); await settle(); });
    expect(useSessionUIStore.getState().currentSessionId).toBeNull(); // The cancelled restore never reopens it.
    expect(shown()).toBeNull();
  } finally { held.resolve(); load.mockRestore(); }
});

test('a pending stock route for A, then B selected, then New session and typing: no ?session= survives a reload', async () => {
  const c = mounted = await mountedNativeComposer(true);
  const other = { ...session, id: '98765432-1234-4234-9234-012345678901' };
  const held = deferred<void>();
  const load = spyOn(globalSessions, 'ensureGlobalSessionsLoaded').mockImplementation(async () => {
    await held.promise; return { activeSessions: [session, other], archivedSessions: [] };
  });
  try {
    await act(async () => {
      useProjectsStore.setState({ managedCatalogAdmitted: false, managedCatalogStatus: 'stock', managedProjects: null, managedRows: null });
      useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, nativeDraftCreations: new Map() });
      window.history.replaceState(null, '', `/?session=${session.id}`);
      await mountRouter(c);
    });
    await act(async () => { useSessionUIStore.getState().setCurrentSession(other.id, directory); await settle(); });
    await act(async () => { useSessionUIStore.getState().openNewSessionDraft(); await settle(); });
    await act(async () => { await c.replace('Unsent draft'); await settle(); });
    // A reload now finds no session in the address and no pointer: the draft is what comes back.
    expect(shown()).toBeNull();
    expect(readLastActiveSession(c.runtimeA)).toBeNull();
    await act(async () => { held.resolve(); await settle(); });
    expect(useSessionUIStore.getState().currentSessionId).toBeNull();
    expect(shown()).toBeNull();
  } finally { held.resolve(); load.mockRestore(); }
});
