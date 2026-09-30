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
import { persistLastActiveSession } from '@/sync/last-session-cache';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getSafeSessionStorage } from '@/stores/utils/safeStorage';
import { setPersonalSidebarView } from '@/lib/sidebar-view';
import { SessionRevealEffect, useRevealSessionPagination } from '@/components/session/sidebar/list/sessionReveal';
import type { SessionGroup, SessionNode } from '@/components/session/sidebar/types';

const win = new Window({ url: 'https://ui.example.test/?session=selected' });
const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const previous = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
const globals = { window: win, document: win.document, IS_REACT_ACT_ENVIRONMENT: true };
for (const key of keys) Object.defineProperty(globalThis, key, { value: globals[key], configurable: true });
const fetch = spyOn(globalThis, 'fetch');
let owner = 'A', limit = 0, denied = false;
let heldRead: Promise<void> | null = null;
const writes: { owner: { issuer: string; subject: string }; projects?: Record<string, boolean>; groups?: Record<string, boolean> }[] = [];
const node = (id: string): SessionNode => ({ session: { id, directory: '/reveal', title: id, projectID: 'p', version: '1', slug: id, time: { created: 1, updated: 1 } }, children: [], worktree: null });
const nodes = Array.from({ length: 9 }, (_, i) => node(`other${i}`)).concat(node('selected'));
const group: SessionGroup = { id: 'worktree:actual', label: 'G', branch: null, description: null, isMain: false, worktree: null, directory: '/reveal', sessions: nodes };
const sections = [{ project: { id: 'p' }, groups: [group] }];
function Page() {
  useRouter();
  useRevealSessionPagination('p:worktree:actual', nodes, count => { limit = count; });
  return <SessionRevealEffect sections={sections} />;
}
let root: Root | null = null;
const settle = () => act(async () => { await sleep(0); await sleep(0); });
const mount = async () => { root = createRoot(document.createElement('div')); await act(async () => root?.render(<Page />)); await settle(); };
const unmount = async () => { await act(async () => root?.unmount()); root = null; };
const bootstrap = () => {
  useProjectsStore.getState().applyManagedCatalog([{ id: 'p', worktree: '/reveal' }]);
  useGlobalSessionsStore.getState().applySnapshot(nodes.map(n => n.session), [], 'ready');
  useSessionUIStore.getState().setCurrentSession('selected', '/reveal', 'restore');
};
beforeEach(async () => {
  await unmount(); owner = 'A'; limit = 0; denied = false; heldRead = null; writes.length = 0;
  getSafeSessionStorage().clear(); configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example.test' });
  useAuthSessionStore.getState().markAuthenticated(); useHumanAuth.setState({ enabled: true });
  fetch.mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/config/sidebar-view')) {
      if (init?.method === 'PATCH') { writes.push(JSON.parse(String(init.body))); return Response.json({}); }
      const requestedOwner = owner; await heldRead;
      return denied ? new Response(null, { status: 403 }) : Response.json({ owner: { issuer: 'test', subject: requestedOwner }, projects: { p: true }, groups: { 'p:worktree:actual': true } });
    }
    return Response.json([]);
  });
  win.history.replaceState({}, '', '/?session=selected'); bootstrap();
});
afterAll(async () => {
  await unmount(); fetch.mockRestore(); useHumanAuth.setState({ enabled: false }); configureRuntimeUrlResolver({});
  for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  await win.happyDOM.close();
});

test('shared URL reveals bootstrap-selected root once, despite another tab last-session pointer', async () => {
  persistLastActiveSession(getRuntimeKey(), { sessionId: 'selected', directory: '/reveal' });
  await mount();
  expect(writes).toEqual([{ owner: { issuer: 'test', subject: 'A' }, projects: { p: false }, groups: { 'p:worktree:actual': false } }]);
  expect(limit).toBe(10); await settle(); expect(writes).toHaveLength(1);
  expect(getSafeSessionStorage().getItem(`oc.tabSession.v1:${JSON.stringify([getRuntimeKey(), 'test', 'A'])}`)).toBe('selected');
});

test('own tab reload retains manual collapse; same-ID popstate still reveals', async () => {
  await mount();
  await act(async () => { await setPersonalSidebarView({ projects: { p: true }, groups: { 'p:worktree:actual': true } }); });
  await unmount(); writes.length = 0; bootstrap();
  const revision = useSessionUIStore.getState().sessionRevealRevision;
  await mount(); expect(useSessionUIStore.getState().sessionRevealRevision).toBe(revision);
  expect(writes).toHaveLength(0);
  await act(async () => win.dispatchEvent(new win.PopStateEvent('popstate'))); await settle();
  expect(writes).toHaveLength(1);
});

test('own reload can restore an unselected session without creating a reveal ticket', async () => {
  await mount(); await unmount(); writes.length = 0;
  useSessionUIStore.getState().setCurrentSession(null, null, 'restore');
  const revision = useSessionUIStore.getState().sessionRevealRevision;
  await mount();
  expect(useSessionUIStore.getState().currentSessionId).toBe('selected');
  expect(useSessionUIStore.getState().sessionRevealRevision).toBe(revision);
  expect(writes).toHaveLength(0);
});

test('blocked tab storage cannot block navigation or borrow another person receipt', async () => {
  const read = spyOn(win.sessionStorage, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  const write = spyOn(win.sessionStorage, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  try { await mount(); expect(useSessionUIStore.getState().currentSessionId).toBe('selected'); expect(writes).toHaveLength(1); }
  finally { read.mockRestore(); write.mockRestore(); }
});

test('new tab shared URL is explicit even with the same browser-wide pointer', async () => {
  await mount(); await unmount(); getSafeSessionStorage().clear(); writes.length = 0; bootstrap();
  await mount(); expect(writes).toHaveLength(1); expect(limit).toBe(10);
});

test('B same-ID shared link cannot use A tab metadata or stale humanSelf', async () => {
  await mount(); await unmount(); writes.length = 0;
  owner = 'B'; useAuthSessionStore.getState().markAuthenticated(); bootstrap(); await mount();
  expect(writes).toHaveLength(1); expect(writes[0]?.owner.subject).toBe('B');
});

test('New session clears the shown receipt; reopening the shared URL is explicit again', async () => {
  await mount();
  await act(async () => useSessionUIStore.getState().openNewSessionDraft()); await settle();
  expect(getSafeSessionStorage().getItem(`oc.tabSession.v1:${JSON.stringify([getRuntimeKey(), 'test', 'A'])}`)).toBeNull();
  await unmount(); writes.length = 0;
  win.history.replaceState({}, '', '/?session=selected'); bootstrap(); await mount();
  expect(writes).toHaveLength(1);
});

for (const reason of ['denied', 'gone', 'newer', 'draft', 'stale-person'] as const) test(`unadmitted route never reveals or claims a tab receipt: ${reason}`, async () => {
  let release!: () => void;
  heldRead = new Promise(resolve => { release = resolve; });
  if (reason === 'gone') {
    useSessionUIStore.getState().setCurrentSession(null);
    useGlobalSessionsStore.getState().applySnapshot([], [], 'ready');
  }
  if (reason === 'denied') denied = true;
  await mount();
  if (reason === 'newer') await act(async () => useSessionUIStore.getState().setCurrentSession('other0', '/reveal'));
  if (reason === 'draft') await act(async () => useSessionUIStore.getState().openNewSessionDraft());
  if (reason === 'stale-person') await act(async () => { owner = 'B'; useAuthSessionStore.getState().markAuthenticated(); });
  await act(async () => { release(); await sleep(0); }); await settle();
  expect(writes).toHaveLength(reason === 'newer' ? 1 : 0);
  if (reason === 'newer') expect(limit).toBe(1);
  expect(getSafeSessionStorage().getItem(`oc.tabSession.v1:${JSON.stringify([getRuntimeKey(), 'test', 'A'])}`)).not.toBe('selected');
});
