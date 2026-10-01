import { afterAll, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { createSidebarOwnerFixture } from './sidebar-owner-fixture.js';
import { useHumanAuth } from './human-auth';
import { useAuthSessionStore } from './runtime-auth-expiry';
import { configureRuntimeUrlResolver } from './runtime-url';
import { isRuntimeRequestScopeCurrent } from './runtime-switch';
import { setPersonalSidebarView, usePersonalSidebarView } from './sidebar-view';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { createSession } from '@/sync/session-actions';
import { opencodeClient } from '@/lib/opencode/client';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { findSessionRevealTarget, useSessionReveal } from '@/components/session/sidebar/list/sessionReveal';
import type { SessionGroup, SessionNode } from '@/components/session/sidebar/types';

const win = new Window({ url: 'http://localhost/' });
const names = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const previous = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
const values = { window: win, document: win.document, IS_REACT_ACT_ENVIRONMENT: true };
for (const name of names) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
const fixture = await createSidebarOwnerFixture();
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fixture.fetch);
configureRuntimeUrlResolver({ apiBaseUrl: fixture.baseURL });
useAuthSessionStore.getState().markAuthenticated();
useHumanAuth.setState({ enabled: true });
const session: SessionNode['session'] & { nativeRuntime: 'ordinary' } = {
  id: 'ordinary-root', directory: '/private/P', title: 'Root', projectID: 'P', version: '1',
  slug: 'root', time: { created: 1, updated: 1 }, nativeRuntime: 'ordinary',
};
const node: SessionNode = { session, children: [], worktree: null };
const group: SessionGroup = { id: 'root', label: 'Root', branch: null, description: null,
  isMain: true, worktree: null, directory: '/private/P', sessions: [node] };
const sections = [{ project: { id: 'P' }, groups: [group] }];
let seen: ReturnType<typeof usePersonalSidebarView>;
const revealed: string[] = [];
function Probe() {
  seen = usePersonalSidebarView();
  useSessionReveal(id => findSessionRevealTarget(sections, id), target => { revealed.push(target.groupKey); });
  return null;
}
const settle = () => act(async () => { for (let i = 0; i < 8; i++) await new Promise(done => setTimeout(done, 5)); });
const open = () => act(async () => useSessionUIStore.getState().setCurrentSession(node.session.id, node.session.directory));
const save = (patch: Parameters<typeof setPersonalSidebarView>[0]) => setPersonalSidebarView(patch).then(() => 'accepted', () => 'refused');
async function seed(index: number) {
  fixture.person(index);
  const response = await fixture.fetch(`${fixture.baseURL}/api/config/sidebar-view`, { method: 'PATCH',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      owner: { issuer: fixture.baseURL, subject: fixture.subjects[index] },
      projects: { P: true, Q: true }, groups: { 'P:root': true },
    }) });
  expect(response.ok).toBe(true);
  fixture.requests = [];
}
async function mounted(run: () => Promise<void>) {
  revealed.length = 0;
  useSessionUIStore.getState().setCurrentSession(null);
  useProjectsStore.setState({ projects: [{ id: 'P', path: '/private/P' }, { id: 'Q', path: '/private/Q' }],
    managedCatalogAdmitted: false, managedRows: null, managedProjects: null, managedSessionHold: null });
  useProjectsStore.getState().applyManagedCatalog([{ id: 'P', worktree: '/private/P' }, { id: 'Q', worktree: '/private/Q' }]);
  useGlobalSessionsStore.getState().upsertSession(node.session);
  const root = createRoot(document.createElement('div'));
  try { await act(async () => root.render(<Probe />)); await settle(); await run(); }
  finally { fixture.heldRead?.resolve(); fixture.heldRead = undefined; await act(async () => root.unmount()); }
}
afterAll(async () => {
  fetchSpy.mockRestore(); await fixture.close();
  useHumanAuth.setState({ enabled: false }); configureRuntimeUrlResolver({});
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
  await win.happyDOM.close();
});

for (const failure of ['storage', 'transport'] as const) {
  for (const publication of ['open', 'delayed-ticket', 'delayed-create'] as const) {
    test(`${failure} failed admission retires ${publication}; unrelated B choice cannot replay A reveal`, async () => {
      fixture.readFailure = undefined;
      const beforeA = await fixture.stored(0);
      await seed(1);
      const beforeB = await fixture.stored(1);
      fixture.person(0); fixture.readFailure = failure;
      const held = fixture.gate(); fixture.heldRead = held;
      await mounted(async () => {
        expect(seen.ready).toBe(false);
        await open();
        let finishCreate: (() => void) | undefined;
        let creation: ReturnType<typeof createSession> | undefined;
        const createSpy = publication === 'delayed-create' ? spyOn(opencodeClient, 'createSession').mockImplementation(() =>
          new Promise(resolve => { finishCreate = () => resolve(session); })) : undefined;
        if (createSpy) await act(async () => { creation = createSession('Root', session.directory); });
        const ticket = useSessionUIStore.getState().sessionRevealIntent;
        if (!ticket) throw new Error('Expected pending open ticket');
        expect(useSessionUIStore.getState().currentSessionId).toBe(node.session.id);
        expect(useProjectsStore.getState().managedSessionHold).toBeNull();
        fixture.person(1); // Cookie-only change: deliberately no auth/client event.
        fixture.readFailure = undefined; fixture.heldRead = undefined;
        await act(async () => held.resolve()); await settle();
        expect(isRuntimeRequestScopeCurrent(ticket.scope)).toBe(true);
        expect(seen.ready).toBe(false); expect(fixture.requests).toHaveLength(0);
        if (publication === 'delayed-ticket') await act(async () => {
          useSessionUIStore.getState().publishSessionReveal(ticket, node.session.id);
        });
        if (creation) {
          try { await act(async () => { finishCreate?.(); expect(await creation).toBe(session); }); }
          finally { createSpy?.mockRestore(); }
          expect(useSessionUIStore.getState().sessionRevealRevision).toBe(ticket.revision);
        }
        await act(async () => { expect(await save({ projects: { Q: false } })).toBe('accepted'); });
        await settle();
        expect(revealed).toEqual([]);
        expect(fixture.requests).toHaveLength(1);
        expect(fixture.requests[0]).toEqual({ owner: beforeB.owner, projects: { Q: false } });
        expect((await fixture.stored(1)).projects).toEqual({ P: true, Q: false });
        expect((await fixture.stored(1)).groups).toEqual(beforeB.groups);
        expect(await fixture.stored(0)).toEqual(beforeA);
        expect(useSessionUIStore.getState().sessionRevealIntent).toBeNull();
        // An old publisher must stay refused even after B has successfully hydrated.
        await act(async () => useSessionUIStore.getState().publishSessionReveal(ticket, node.session.id));
        await settle(); expect(fixture.requests).toHaveLength(1); expect(revealed).toEqual([]);
        await open(); await settle();
        expect(revealed).toEqual(['P:root']); expect(fixture.requests).toHaveLength(2);
        expect(fixture.requests[1]).toEqual({ owner: beforeB.owner, projects: { P: false }, groups: { 'P:root': false } });
      });
    });
  }
}

for (const collapse of ['none', 'project', 'group', 'unrelated'] as const) {
  test(`healthy A prehydration reveal with ${collapse} collapse`, async () => {
    fixture.readFailure = undefined;
    await seed(0);
    const held = fixture.gate(); fixture.heldRead = held;
    await mounted(async () => {
      await open(); expect(revealed).toEqual([]); expect(seen.ready).toBe(false);
      let choice: Promise<string> | undefined;
      if (collapse !== 'none') await act(async () => {
        choice = save(collapse === 'project' ? { projects: { P: true } }
          : { groups: { [collapse === 'group' ? 'P:root' : 'Q:root']: true } });
      });
      await act(async () => { held.resolve(); if (choice) expect(await choice).toBe('accepted'); });
      fixture.heldRead = undefined; await settle();
      const cancelled = collapse === 'project' || collapse === 'group';
      expect(revealed).toEqual(cancelled ? [] : ['P:root']);
      expect(fixture.requests).toHaveLength((collapse === 'none' ? 0 : 1) + (cancelled ? 0 : 1));
      expect(fixture.requests.every(request => request.owner.subject === fixture.subjects[0])).toBe(true);
      expect((await fixture.stored(0)).projects.P).toBe(cancelled);
      expect(useSessionUIStore.getState().sessionRevealIntent).toBeNull();
    });
  });
}
