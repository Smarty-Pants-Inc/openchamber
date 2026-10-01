import { spyOn } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';
import { createRequire } from 'node:module';
import { useHumanAuth } from '@/lib/human-auth';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import { resetRuntimeAuthGeneration } from '@/lib/runtime-auth';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { createWebAPIs } from '../../../../../../web/src/api';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';

export const targetGroup = 'p:worktree:w';
export const unrelatedGroup = 'q:worktree:v';
export const settle = () => act(async () => {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));
});

export async function initialReadFixture(human = true) {
  const win = new Window({ url: 'https://ui.example.test/' });
  const values = {
    window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage,
    HTMLElement: win.HTMLElement, Element: win.Element, Node: win.Node,
    Event: win.Event, MouseEvent: win.MouseEvent, KeyboardEvent: win.KeyboardEvent,
    PointerEvent: win.PointerEvent, ResizeObserver: win.ResizeObserver,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(values).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const owner = { issuer: 'fixture-issuer', subject: 'person-a' };
  const users = new Map(['person-a', 'person-b'].map(id => [id, { id, sidebarPreferences: JSON.stringify({
    projects: {}, groups: { [targetGroup]: true, [unrelatedGroup]: true },
  }) }]));
  // Only external admission and database IO are faked. Parsing, owner guards,
  // serialization and sparse PATCH merge are the real server implementation.
  const serverOptions = {
    auth: { $context: Promise.resolve({ adapter: {
      findOne: async ({ model, where }: { model: string; where: { field: string; value: string }[] }) => model === 'user'
        ? users.get(where[0]!.value)
        : { userId: where[0]!.value, expiresAt: new Date(Date.now() + 60_000) },
      update: async ({ where, update }: { where: { value: string }[]; update: { sidebarPreferences: string } }) => {
        const user = users.get(where[0]!.value);
        if (!user) throw new Error('Missing fixture person');
        user.sidebarPreferences = update.sidebarPreferences;
        return user;
      },
    } }) },
    resolve: async (req: { humanIdentity: typeof owner }) => ({ session: { id: req.humanIdentity.subject }, owner: req.humanIdentity }),
    actor: (session: { owner: typeof owner }) => session.owner,
  };
  type Maps = { projects: Record<string, boolean>; groups: Record<string, boolean> };
  // The owning server is untyped JS; this narrow boundary mirrors its exported
  // constructor and parsed return shape, without asserting or replacing its logic.
  const { createHumanSidebarView }: {
    createHumanSidebarView(options: typeof serverOptions): (req: {
      method: string; humanIdentity: typeof owner; body?: { owner: typeof owner; projects?: Maps['projects']; groups?: Maps['groups'] };
    }) => Promise<Maps & { owner: typeof owner }>;
  } = createRequire(import.meta.url)('../../../../../../web/server/lib/ui-auth/human-sidebar-view.js');
  const server = createHumanSidebarView(serverOptions);
  const writes: { method: string; body: string }[] = [];
  const reads: { release: (status?: number) => void; released: boolean }[] = [];
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') writes.push({ method, body: String(init?.body ?? '') });
    if (!url.endsWith('/api/config/sidebar-view')) return Response.json({ projects: [] }, {
      headers: { 'X-OpenChamber-Settings-CAS': '1', ETag: '"fixture"' },
    });
    const admitted = { ...owner };
    const data = await server({ method, humanIdentity: admitted, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method !== 'GET') return Response.json(data);
    return await new Promise<Response>(resolve => {
      const read = { released: false, release: (status = 200) => {
        if (read.released) return;
        read.released = true;
        resolve(Response.json(status === 200 ? data : { error: 'Preferences unavailable' }, { status }));
      } };
      reads.push(read);
    });
  });
  resetRuntimeAuthGeneration();
  useAuthSessionStore.setState({ state: 'ok' });
  useHumanAuth.setState({ enabled: human });
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example.test' });
  registerRuntimeAPIs(createWebAPIs());
  useSessionDisplayStore.setState({ projectDisplayMode: 'all' });
  const storage = getDeferredSafeStorage();
  storage.setItem('oc.sessions.projectCollapse', JSON.stringify(['p']));
  storage.setItem('oc.sessions.groupCollapse', JSON.stringify([targetGroup, unrelatedGroup]));
  const { useSessionProjectViewState } = await import('./useSessionProjectViewState');
  const { SidebarHeader } = await import('../shell/SidebarHeader');
  const { TooltipProvider } = await import('@/components/ui/tooltip');
  const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
  const { I18nProvider } = await import('@/lib/i18n');
  let view: ReturnType<typeof useSessionProjectViewState> | undefined;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const Probe = ({ hidden = false }: { hidden?: boolean }) => {
    view = useSessionProjectViewState({ isVSCode: false, projects: [{ id: 'p', sidebarCollapsed: true }] });
    return <ThemeSystemProvider><I18nProvider><TooltipProvider><SidebarHeader
      hideDirectoryControls={hidden} showProjectDisplayControls showRecentControls
      handleOpenDirectoryDialog={() => {}} onOpenScheduled={() => {}} onOpenMultiRun={() => {}}
      canOpenMultiRun={false} onOpenArchive={() => {}} headerActionIconClass="" headerActionButtonClass=""
      isSessionSearchOpen={false} setIsSessionSearchOpen={() => {}} sessionSearchInputRef={{ current: null }}
      sessionSearchQuery="" setSessionSearchQuery={() => {}} hasSessionSearchQuery={false} searchMatchCount={0}
      collapseAllProjects={view.actions.collapseAllProjects} expandAllProjects={view.actions.expandAllProjects}
      bulkActionsReady={view.bulkActionsReady}
    /></TooltipProvider></I18nProvider></ThemeSystemProvider>;
  };
  const render = async (hidden = false) => { await act(async () => root.render(<Probe hidden={hidden} />)); await settle(); };
  const menuItem = async (label = 'Expand all') => {
    if (!document.querySelector('[role="menu"]')) {
      const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Display mode"]');
      if (!trigger) throw new Error('Missing actual Display mode trigger');
      await act(async () => trigger.click()); await settle();
    }
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.trim() === label);
    if (!item) throw new Error(`Missing actual menu item ${label}`);
    return item;
  };
  return {
    render, menuItem, writes, reads, owner,
    get view() { if (!view) throw new Error('Hook not mounted'); return view; },
    persisted(subject = 'person-a'): Maps { return JSON.parse(users.get(subject)!.sidebarPreferences); },
    async release(index = 0, status = 200) {
      if (!reads[index]) throw new Error(`Initial GET ${index} was not issued`);
      await act(async () => reads[index]!.release(status)); await settle();
    },
    async switchPerson() {
      owner.subject = 'person-b';
      await act(async () => useAuthSessionStore.getState().markAuthenticated()); await settle();
    },
    async close() {
      await act(async () => {
        for (const read of reads) read.release();
        root.unmount();
        useHumanAuth.setState({ enabled: false });
      });
      await settle();
      fetchSpy.mockRestore(); registerRuntimeAPIs(null); configureRuntimeUrlResolver({});
      container.remove();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
      }
      await win.happyDOM.close();
    },
  };
}
