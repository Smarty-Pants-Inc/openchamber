import { spyOn } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';
import { createRequire } from 'node:module';
import { useHumanAuth } from '@/lib/human-auth';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { captureRuntimeRequestScope, isRuntimeRequestScopeCurrent } from '@/lib/runtime-switch';
import { toast } from 'sonner';

export const targetGroup = 'p:worktree:w';
export const settle = () => act(async () => {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));
});

// Call once per isolated test process. No beforeEach warms the singleton.
export async function freshModuleFixture() {
  const win = new Window({ url: 'https://ui.example.test/' });
  const values = { window: win, document: win.document, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.keys(values).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const owner = { issuer: 'fixture-issuer', subject: 'person-a' };
  const users = new Map(['person-a', 'person-b'].map(id => [id, { id, sidebarPreferences: JSON.stringify({
    projects: {}, groups: { unrelated: true },
  }) }]));
  // Only transport, external admission, and database IO are fake. Sparse merge
  // and expected-owner enforcement below are the owning server implementation.
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
  // Narrow constructor signature at the untyped owning JS module boundary.
  const { createHumanSidebarView }: {
    createHumanSidebarView(options: typeof serverOptions): (req: {
      method: string; humanIdentity: typeof owner; body?: { owner: typeof owner; projects?: Maps['projects']; groups?: Maps['groups'] };
    }) => Promise<Maps & { owner: typeof owner }>;
  } = createRequire(import.meta.url)('../../../../../../web/server/lib/ui-auth/human-sidebar-view.js');
  const server = createHumanSidebarView(serverOptions);
  const writes: { method: string; body: string; subject: string }[] = [];
  const reads: { release: () => void; released: boolean }[] = [];
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/api/fs/home')) return Response.json({ home: '/fixture' });
    if (!url.endsWith('/api/config/sidebar-view')) throw new Error(`Unexpected fixture request ${url}`);
    const method = init?.method ?? 'GET';
    const admitted = { ...owner };
    if (method !== 'GET') writes.push({ method, body: String(init?.body ?? ''), subject: admitted.subject });
    const data = await server({ method, humanIdentity: admitted, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method !== 'GET') return Response.json(data);
    return await new Promise<Response>(resolve => {
      const read = { released: false, release: () => {
        if (read.released) return;
        read.released = true;
        resolve(Response.json(data));
      } };
      reads.push(read);
    });
  });
  const failures = spyOn(toast, 'error');
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example.test' });
  useHumanAuth.setState({ enabled: true });
  useAuthSessionStore.getState().markReauthenticating();
  // Exactly the gate ordering: source module evaluates BEFORE verified auth;
  // markAuthenticated renews request authority BEFORE any sidebar render.
  const { useSessionProjectViewState } = await import('./useSessionProjectViewState');
  const personal = await import('@/lib/sidebar-view');
  const importedScope = captureRuntimeRequestScope();
  useAuthSessionStore.getState().markAuthenticated();
  const importedScopeRetired = !isRuntimeRequestScopeCurrent(importedScope);
  const mutations: Parameters<typeof personal.setPersonalSidebarView>[0][] = [];
  const unsubscribe = personal.subscribePersonalSidebarViewMutations(patch => mutations.push(patch));
  const projects = [{ id: 'p', sidebarCollapsed: true }];
  let view: ReturnType<typeof useSessionProjectViewState> | undefined;
  let renders = 0;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const Probe = () => {
    renders++;
    view = useSessionProjectViewState({ isVSCode: false, projects });
    return <><button data-manual="project" onClick={() => view?.actions.toggleProject('p')} />
      <button data-manual="group" onClick={() => view?.actions.toggleGroup(targetGroup)} /></>;
  };
  return {
    writes, reads, owner, importedScopeRetired, mutations, personal,
    get renders() { return renders; },
    get failures() { return failures.mock.calls.length; },
    get view() { if (!view) throw new Error('Hook not mounted'); return view; },
    persisted(subject = 'person-a'): Maps { return JSON.parse(users.get(subject)!.sidebarPreferences); },
    async render() { await act(async () => root.render(<Probe />)); await settle(); },
    async click(kind: 'project' | 'group') {
      const button = container.querySelector<HTMLButtonElement>(`[data-manual="${kind}"]`);
      if (!button) throw new Error('Missing manual fixture control');
      await act(async () => button.click()); await settle();
    },
    async release(index = 0) {
      const read = reads[index];
      if (!read) throw new Error(`GET ${index} not issued`);
      await act(async () => read.release()); await settle();
    },
    async switchPerson() {
      owner.subject = 'person-b';
      await act(async () => useAuthSessionStore.getState().markAuthenticated()); await settle();
    },
    async close() {
      await act(async () => { for (const read of reads) read.release(); root.unmount(); });
      await settle(); unsubscribe(); fetchSpy.mockRestore(); failures.mockRestore();
      useHumanAuth.setState({ enabled: false }); configureRuntimeUrlResolver({}); container.remove();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
      }
      await win.happyDOM.close();
    },
  };
}
