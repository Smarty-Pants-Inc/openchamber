import { afterAll, beforeEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setTimeout as sleep } from 'node:timers/promises';
import { Window } from 'happy-dom';
import { useRouter } from '@/hooks/useRouter';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useHumanAuth } from '@/lib/human-auth';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import { getSafeSessionStorage } from '@/stores/utils/safeStorage';
import { setPersonalSidebarView, usePersonalSidebarView } from '@/lib/sidebar-view';
import { createSidebarOwnerFixture } from '@/lib/sidebar-owner-fixture.js';
import { SessionRevealEffect, useRevealSessionPagination } from '@/components/session/sidebar/list/sessionReveal';
import type { SessionGroup, SessionNode } from '@/components/session/sidebar/types';

const win = new Window({ url: 'https://ui.example.test/?session=selected' });
const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const previous = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
const globals = { window: win, document: win.document, IS_REACT_ACT_ENVIRONMENT: true };
for (const key of keys) Object.defineProperty(globalThis, key, { value: globals[key], configurable: true });
const fixture = await createSidebarOwnerFixture();
const fetch = spyOn(globalThis, 'fetch');
const node = (id: string): SessionNode => ({ session: { id, directory: '/reveal', title: id,
  projectID: 'p', version: '1', slug: id, time: { created: 1, updated: 1 } }, children: [], worktree: null });
const nodes = Array.from({ length: 9 }, (_, i) => node(`other${i}`)).concat(node('selected'));
const groupKey = 'p:worktree:actual';
const group: SessionGroup = { id: 'worktree:actual', label: 'G', branch: null, description: null,
  isMain: false, worktree: null, directory: '/reveal', sessions: nodes };
const sections = [{ project: { id: 'p' }, groups: [group] }];
let root: Root | null = null, limit = 0;
let personal: ReturnType<typeof usePersonalSidebarView>;
let readCompleted = false, readStatus = 0;
const operations: string[] = [];
function Page() {
  useRouter();
  personal = usePersonalSidebarView();
  useRevealSessionPagination(groupKey, nodes, count => { limit = count; });
  return <SessionRevealEffect sections={sections} />;
}
const settle = () => act(async () => { await sleep(40); await sleep(0); });
const unmount = async () => { await act(async () => root?.unmount()); root = null; };
beforeEach(async () => {
  await unmount(); fixture.person(0); fixture.heldRead = undefined; fixture.readFailure = undefined; fixture.refuse = false;
  await fixture.seed(0, { p: true }); fixture.requests = []; fixture.gets = 0;
  limit = 0; readCompleted = false; readStatus = 0; operations.length = 0;
  getSafeSessionStorage().clear(); configureRuntimeUrlResolver({ apiBaseUrl: fixture.baseURL });
  useAuthSessionStore.getState().markAuthenticated(); useHumanAuth.setState({ enabled: true });
  fetch.mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const ownerRead = url.includes('/api/config/sidebar-view') && init?.method !== 'PATCH';
    if (ownerRead) operations.push('GET dispatched');
    const response = await fixture.fetch(input, init);
    if (ownerRead) { readCompleted = true; readStatus = response.status; operations.push('GET completed'); }
    return response;
  });
  win.history.replaceState({}, '', '/?session=selected');
  useProjectsStore.getState().applyManagedCatalog([{ id: 'p', worktree: '/reveal' }]);
  useGlobalSessionsStore.getState().applySnapshot(nodes.map(n => n.session), [], 'ready');
  useSessionUIStore.getState().setCurrentSession('selected', '/reveal', 'restore');
});
afterAll(async () => {
  await unmount(); fetch.mockRestore(); await fixture.close(); useHumanAuth.setState({ enabled: false });
  configureRuntimeUrlResolver({});
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
  await win.happyDOM.close();
});

for (const choice of ['project', 'group', 'unrelated', 'none'] as const) {
  test(`actual shared-link owner GET preserves newer ${choice} collapse and permits explicit same-ID reopen`, async () => {
    const held = fixture.gate(); fixture.heldRead = held;
    root = createRoot(document.createElement('div'));
    await act(async () => root?.render(<Page />)); await settle();
    expect(fixture.gets).toBe(1); expect(readCompleted).toBe(false);
    expect(operations).toEqual(['GET dispatched']); expect(fixture.requests).toHaveLength(0);
    let saved = Promise.resolve();
    try {
      if (choice !== 'none') {
        await act(async () => {
          operations.push('manual collapse');
          // The same public sparse mutation used by sidebar actions, without awaiting the held owner.
          saved = setPersonalSidebarView(choice === 'group' ? { groups: { [groupKey]: true } }
            : { projects: { [choice === 'project' ? 'p' : 'q']: true } });
        });
        expect(readCompleted).toBe(false); expect(fixture.gets).toBe(1);
        expect(personal.ready).toBe(false); expect(fixture.requests).toHaveLength(0);
        expect(choice === 'group' ? personal.groups[groupKey] : personal.projects[choice === 'project' ? 'p' : 'q']).toBe(true);
      }
    } finally {
      operations.push('release original GET');
      await act(async () => held.resolve()); fixture.heldRead = undefined;
    }
    await act(async () => { await saved; }); await settle();
    expect(readStatus).toBe(200); expect(fixture.gets).toBe(1);
    expect(operations).toEqual(['GET dispatched', ...(choice === 'none' ? [] : ['manual collapse']),
      'release original GET', 'GET completed']);
    const cancelled = choice === 'project' || choice === 'group';
    const manual = choice === 'none' ? [] : [{ owner: { issuer: fixture.baseURL, subject: fixture.subjects[0] },
      ...(choice === 'group' ? { groups: { [groupKey]: true } } : { projects: { [choice === 'project' ? 'p' : 'q']: true } }) }];
    const expansion = { owner: { issuer: fixture.baseURL, subject: fixture.subjects[0] },
      projects: { p: false }, groups: { [groupKey]: false } };
    const stored = await fixture.stored(0);
    const afterRoute = { selected: useSessionUIStore.getState().currentSessionId,
      url: win.location.search, collapsed: personal.projects.p, storedCollapsed: stored.projects.p,
      groupCollapsed: personal.groups[groupKey] ?? false, requests: [...fixture.requests], limit };
    await settle(); await settle();
    const afterRepeat = [...fixture.requests];
    // Capture cancellation first, then exercise a new explicit router action without manufacturing state.
    await act(async () => win.dispatchEvent(new win.PopStateEvent('popstate'))); await settle();
    expect(useSessionUIStore.getState().currentSessionId).toBe('selected');
    expect(win.location.search).toBe('?session=selected'); expect(personal.projects.p).toBe(false);
    expect(personal.groups[groupKey]).toBe(false); expect(limit).toBe(10);
    expect(fixture.requests).toEqual([...afterRepeat, expansion]);
    expect(afterRepeat).toEqual(afterRoute.requests);
    expect(afterRoute).toEqual({ selected: 'selected', url: '?session=selected', collapsed: cancelled,
      storedCollapsed: cancelled, groupCollapsed: choice === 'group',
      requests: cancelled ? manual : [...manual, expansion], limit: cancelled ? 0 : 10 });
  });
}

for (const mode of ['later-expand', 'refused-save'] as const) {
  test(`pre-owner collapse cancellation survives ${mode}`, async () => {
    const held = fixture.gate(); fixture.heldRead = held;
    fixture.refuse = mode === 'refused-save';
    root = createRoot(document.createElement('div'));
    await act(async () => root?.render(<Page />)); await settle();
    expect(readCompleted).toBe(false); expect(fixture.gets).toBe(1);
    const saves: Promise<string>[] = [];
    const choose = (collapsed: boolean) => setPersonalSidebarView({ projects: { p: collapsed } })
      .then(() => 'accepted', () => 'refused');
    try {
      await act(async () => { saves.push(choose(true)); });
      if (mode === 'later-expand') await act(async () => { saves.push(choose(false)); });
      expect(readCompleted).toBe(false); expect(fixture.requests).toHaveLength(0);
    } finally {
      await act(async () => held.resolve()); fixture.heldRead = undefined;
    }
    await act(async () => {
      expect(await Promise.all(saves)).toEqual(mode === 'later-expand' ? ['accepted', 'accepted'] : ['refused']);
    }); await settle();
    const owner = { issuer: fixture.baseURL, subject: fixture.subjects[0] };
    expect(fixture.requests).toEqual(mode === 'later-expand'
      ? [{ owner, projects: { p: true } }, { owner, projects: { p: false } }]
      : [{ owner, projects: { p: true } }]);
    expect(useSessionUIStore.getState().currentSessionId).toBe('selected');
    expect(win.location.search).toBe('?session=selected'); expect(limit).toBe(0);
    expect(personal.projects.p).toBe(mode === 'refused-save');
    expect((await fixture.stored(0)).projects.p).toBe(mode === 'refused-save');
    expect(useSessionUIStore.getState().sessionRevealIntent).toBeNull();
  });
}

test('pre-owner collapse cannot cancel a fresh selection from a synchronous begin subscriber', async () => {
  const held = fixture.gate(); fixture.heldRead = held;
  root = createRoot(document.createElement('div'));
  await act(async () => root?.render(<Page />)); await settle();
  let save = Promise.resolve(), armed = true;
  const stop = useSessionUIStore.subscribe((state, before) => {
    if (!armed || state.sessionRevealRevision === before.sessionRevealRevision) return;
    armed = false;
    useSessionUIStore.getState().setCurrentSession('other0', '/reveal');
  });
  try {
    await act(async () => { save = setPersonalSidebarView({ projects: { p: true } }); });
    expect(readCompleted).toBe(false);
    await act(async () => held.resolve()); fixture.heldRead = undefined;
    await act(async () => { await save; }); await settle();
    const owner = { issuer: fixture.baseURL, subject: fixture.subjects[0] };
    expect(armed).toBe(false);
    expect(useSessionUIStore.getState().currentSessionId).toBe('other0');
    expect(personal.projects.p).toBe(false);
    expect(fixture.requests).toEqual([{ owner, projects: { p: true } },
      { owner, projects: { p: false }, groups: { [groupKey]: false } }]);
    expect(useSessionUIStore.getState().sessionRevealIntent).toBeNull();
  } finally { stop(); held.resolve(); fixture.heldRead = undefined; }
});
