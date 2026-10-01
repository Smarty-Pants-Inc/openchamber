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
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getSafeSessionStorage } from '@/stores/utils/safeStorage';
import { capturePersonalSidebarAdmission, isPersonalSidebarAdmissionCurrent,
  setPersonalSidebarView, usePersonalSidebarView } from '@/lib/sidebar-view';
import { createSidebarOwnerFixture } from '@/lib/sidebar-owner-fixture.js';
import { SessionRevealEffect } from '@/components/session/sidebar/list/sessionReveal';
import type { SessionGroup, SessionNode } from '@/components/session/sidebar/types';

const win = new Window({ url: 'https://ui.example.test/?session=A' });
const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const previous = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
const globals = { window: win, document: win.document, IS_REACT_ACT_ENVIRONMENT: true };
for (const key of keys) Object.defineProperty(globalThis, key, { value: globals[key], configurable: true });
const fixture = await createSidebarOwnerFixture();
const fetch = spyOn(globalThis, 'fetch');
const node = (id: string): SessionNode => ({ session: { id, directory: `/root-${id}`, title: id,
  projectID: `p${id}`, version: '1', slug: id, time: { created: 1, updated: 1 } }, children: [], worktree: null });
const nodes = [node('A'), node('B')];
const groupKey = 'pB:worktree:B';
const sections = nodes.map(n => ({ project: { id: n.session.projectID }, groups: [{
  id: `worktree:${n.session.id}`, label: n.session.id, branch: null, description: null,
  isMain: false, worktree: null, directory: n.session.directory, sessions: [n],
} satisfies SessionGroup] }));
let root: Root | null = null;
let personal: ReturnType<typeof usePersonalSidebarView>;
let readCompleted = false, readStatus = 0;
function Page() {
  useRouter();
  personal = usePersonalSidebarView();
  return <SessionRevealEffect sections={sections} />;
}
const settle = () => act(async () => { await sleep(40); await sleep(0); });
const mount = async () => {
  root = createRoot(document.createElement('div'));
  await act(async () => root?.render(<Page />)); await settle();
};
const unmount = async () => { await act(async () => root?.unmount()); root = null; };
const receipt = () => getSafeSessionStorage().getItem(
  `oc.tabSession.v1:${JSON.stringify([getRuntimeKey(), fixture.baseURL, fixture.subjects[0]])}`);
const selectB = () => act(async () => useSessionUIStore.getState().setCurrentSession('B', '/root-B'));
beforeEach(async () => {
  await unmount(); fixture.person(0); fixture.heldRead = undefined;
  fixture.readFailure = undefined; fixture.refuse = false;
  await fixture.seed(0, { pA: true, pB: true }); fixture.requests = []; fixture.gets = 0;
  readCompleted = false; readStatus = 0; getSafeSessionStorage().clear();
  configureRuntimeUrlResolver({ apiBaseUrl: fixture.baseURL });
  useAuthSessionStore.getState().markAuthenticated(); useHumanAuth.setState({ enabled: true });
  fetch.mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes('/api/config/sidebar-view')) return Response.json([]);
    const response = await fixture.fetch(input, init);
    if (init?.method !== 'PATCH') { readCompleted = true; readStatus = response.status; }
    return response;
  });
  win.history.replaceState({}, '', '/?session=A');
  useProjectsStore.getState().applyManagedCatalog([
    { id: 'pA', worktree: '/root-A' }, { id: 'pB', worktree: '/root-B' },
  ]);
  useGlobalSessionsStore.getState().applySnapshot(nodes.map(n => n.session), [], 'ready');
  useSessionUIStore.getState().setCurrentSession('A', '/root-A', 'restore');
});
afterAll(async () => {
  await unmount(); fetch.mockRestore(); await fixture.close(); useHumanAuth.setState({ enabled: false });
  configureRuntimeUrlResolver({});
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
  await win.happyDOM.close();
});

for (const pending of [true, false]) {
  test(pending ? 'superseded initial route must retain newer B receipt and own-reload collapse'
    : 'healthy settled selection B records receipt and preserves own-reload collapse', async () => {
    const held = fixture.gate();
    if (pending) fixture.heldRead = held;
    const admission = capturePersonalSidebarAdmission();
    const scopeKey = getRuntimeKey();
    const initialRevision = useSessionUIStore.getState().sessionRevealRevision;
    try {
      await mount();
      if (pending) {
        expect(fixture.gets).toBe(1); expect(readCompleted).toBe(false);
        expect(receipt()).toBeNull(); expect(fixture.requests).toHaveLength(0);
        expect(useSessionUIStore.getState().sessionRevealRevision).toBe(initialRevision);
      } else {
        expect(readStatus).toBe(200); expect(receipt()).toBe('A');
      }
      await selectB();
      const selectedRevision = useSessionUIStore.getState().sessionRevealRevision;
      if (pending) {
        expect(selectedRevision).toBe(initialRevision + 1);
        expect(readCompleted).toBe(false); expect(receipt()).toBeNull();
        await act(async () => held.resolve()); fixture.heldRead = undefined;
      }
      await settle(); await settle();
      expect(readStatus).toBe(200); expect(isPersonalSidebarAdmissionCurrent(admission)).toBe(true);
      expect(getRuntimeKey()).toBe(scopeKey);
      expect(useSessionUIStore.getState().currentSessionId).toBe('B');
      expect(win.location.search).toBe('?session=B');
      expect(useSessionUIStore.getState().sessionRevealRevision).toBe(selectedRevision);
      expect(personal.projects.pB).toBe(false); expect(personal.groups[groupKey]).toBe(false);
      expect(fixture.requests.filter(patch => patch.projects?.pA === false)).toHaveLength(pending ? 0 : 1);
      // A fresh supported same-ID action, not popstate (which would itself write a route receipt).
      await selectB(); await settle(); await settle();
      const afterReopenReceipt = receipt();
      await act(async () => { await setPersonalSidebarView({ projects: { pB: true }, groups: { [groupKey]: true } }); });
      await settle();
      expect(personal.projects.pB).toBe(true); expect(personal.groups[groupKey]).toBe(true);
      const beforeReload = await fixture.stored(0);
      expect(beforeReload.projects.pB).toBe(true); expect(beforeReload.groups[groupKey]).toBe(true);
      await unmount();
      const revision = useSessionUIStore.getState().sessionRevealRevision;
      const writes = fixture.requests.length;
      // Own reload: same URL and exact same safe session storage, with no fabricated receipt/ticket.
      await mount(); await settle(); await settle();
      const stored = await fixture.stored(0);
      const observed = { afterReopenReceipt, selected: useSessionUIStore.getState().currentSessionId,
        url: win.location.search, revisionDelta: useSessionUIStore.getState().sessionRevealRevision - revision,
        reloadPatches: fixture.requests.slice(writes), projectCollapsed: personal.projects.pB,
        groupCollapsed: personal.groups[groupKey], storedProjectCollapsed: stored.projects.pB,
        storedGroupCollapsed: stored.groups[groupKey] };
      console.log('SUPERSEDED_ROUTE_RECEIPT', JSON.stringify({ pending, observed }));
      expect(observed).toEqual({ afterReopenReceipt: 'B', selected: 'B', url: '?session=B', revisionDelta: 0,
        reloadPatches: [], projectCollapsed: true, groupCollapsed: true,
        storedProjectCollapsed: true, storedGroupCollapsed: true });
    } finally {
      held.resolve(); fixture.heldRead = undefined;
      await unmount();
    }
  });
}
