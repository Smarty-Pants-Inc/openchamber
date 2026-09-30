import { afterAll, expect, spyOn, test } from 'bun:test';
import React, { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { createSidebarOwnerFixture } from './sidebar-owner-fixture.js';
import { useHumanAuth } from './human-auth';
import { useAuthSessionStore } from './runtime-auth-expiry';
import { configureRuntimeUrlResolver } from './runtime-url';
import { captureRuntimeRequestScope } from './runtime-switch';
import { capturePersonalSidebarAdmission, isPersonalSidebarAdmissionCurrent, readPersonalSidebarOwner,
  setPersonalSidebarView, usePersonalSidebarView } from './sidebar-view';
import { useSessionUIStore, type SessionRevealTicket } from '@/sync/session-ui-store';
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
let root: Root | null = null;
let seen: ReturnType<typeof usePersonalSidebarView>;
const revealed: string[] = [];
const node: SessionNode = { session: { id: 'bootstrap-root', directory: '/private/P', title: 'Root', projectID: 'P',
  version: '1', slug: 'root', time: { created: 1, updated: 1 } }, children: [], worktree: null };
const group: SessionGroup = { id: 'root', label: 'Root', branch: null, description: null,
  isMain: true, worktree: null, directory: '/private/P', sessions: [node] };
const sections = [{ project: { id: 'P' }, groups: [group] }];
function Probe() {
  seen = usePersonalSidebarView();
  useSessionReveal(id => findSessionRevealTarget(sections, id), target => { revealed.push(target.groupKey); });
  return null;
}
const settle = () => act(async () => { for (let i = 0; i < 8; i++) await new Promise(done => setTimeout(done, 5)); });
const unmount = async () => { await act(async () => root?.unmount()); root = null; };
const mount = async (strict = false) => {
  root = createRoot(document.createElement('div'));
  await act(async () => root?.render(strict ? <StrictMode><Probe /></StrictMode> : <Probe />)); await settle();
};
const open = () => act(async () => useSessionUIStore.getState().setCurrentSession(node.session.id, node.session.directory));
async function reset() {
  await unmount(); fixture.person(0); fixture.readFailure = undefined; fixture.refuse = false;
  fixture.heldRead = undefined; revealed.length = 0;
  await fixture.seed(0, { P: true }); fixture.requests = [];
  useAuthSessionStore.getState().markAuthenticated(); useHumanAuth.setState({ enabled: true });
  useSessionUIStore.getState().setCurrentSession(null);
  useProjectsStore.getState().applyManagedCatalog([{ id: 'P', worktree: '/private/P' }]);
  useGlobalSessionsStore.getState().upsertSession(node.session);
}
afterAll(async () => {
  await unmount(); fetchSpy.mockRestore(); await fixture.close();
  useHumanAuth.setState({ enabled: false }); configureRuntimeUrlResolver({});
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
  await win.happyDOM.close();
});

for (const bootstrap of ['before-acquire', 'imperative-owner', 'strict-remount'] as const) {
  test(`healthy explicit open preserves initiating cohort through ${bootstrap}`, async () => {
    await reset();
    if (bootstrap === 'imperative-owner') {
      expect((await readPersonalSidebarOwner(captureRuntimeRequestScope()))?.subject).toBe(fixture.subjects[0]);
    }
    const held = fixture.gate(); fixture.heldRead = held;
    await open();
    const ticket = useSessionUIStore.getState().sessionRevealIntent;
    if (!ticket) throw new Error('Expected original explicit-open ticket');
    await mount(bootstrap === 'strict-remount');
    expect(isPersonalSidebarAdmissionCurrent(ticket.preferenceAdmission)).toBe(true);
    if (bootstrap !== 'imperative-owner') { expect(revealed).toEqual([]); expect(seen.ready).toBe(false); }
    if (bootstrap === 'strict-remount') {
      await unmount(); await mount(true);
      expect(isPersonalSidebarAdmissionCurrent(ticket.preferenceAdmission)).toBe(true);
    }
    await act(async () => held.resolve()); fixture.heldRead = undefined; await settle();
    expect(revealed).toEqual(['P:root']); expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]).toEqual({ owner: { issuer: fixture.baseURL, subject: fixture.subjects[0] },
      projects: { P: false }, groups: { 'P:root': false } });
    expect((await fixture.stored(0)).projects.P).toBe(false);
    await unmount();
    const admission = capturePersonalSidebarAdmission();
    await mount(bootstrap === 'strict-remount');
    expect(isPersonalSidebarAdmissionCurrent(admission)).toBe(true);
    expect(revealed).toEqual(['P:root']); expect(fixture.requests).toHaveLength(1);
  });
}

test('old known-owner pending ticket cannot borrow B owner on ordinary reacquire', async () => {
  await reset(); await fixture.seed(1, { P: true }); fixture.requests = [];
  const beforeB = await fixture.stored(1);
  await mount();
  let ticket!: SessionRevealTicket;
  await act(async () => { ticket = useSessionUIStore.getState().beginSessionReveal(); });
  expect(isPersonalSidebarAdmissionCurrent(ticket.preferenceAdmission)).toBe(true);
  await unmount(); fixture.person(1);
  await mount();
  expect(isPersonalSidebarAdmissionCurrent(ticket.preferenceAdmission)).toBe(false);
  expect((await readPersonalSidebarOwner(ticket.scope))?.subject).toBe(fixture.subjects[1]);
  await act(async () => useSessionUIStore.getState().setCurrentSession(node.session.id, node.session.directory, 'restore', ticket));
  await settle(); expect(revealed).toEqual([]); expect(fixture.requests).toHaveLength(0);
  expect(await fixture.stored(1)).toEqual(beforeB);
  await open(); await settle(); expect(revealed).toEqual(['P:root']); expect(fixture.requests).toHaveLength(1);
  expect(fixture.requests[0].owner).toEqual(beforeB.owner);
});

for (const collapse of ['none', 'project', 'group'] as const) {
  test(`failed same-owner admission with ${collapse} collapse cannot revive old action after retry`, async () => {
    await reset(); fixture.readFailure = 'storage';
    const held = fixture.gate(); fixture.heldRead = held;
    await mount(); await open();
    const ticket = useSessionUIStore.getState().sessionRevealIntent;
    if (!ticket) throw new Error('Expected pending ticket');
    let choice: Promise<string> | undefined;
    if (collapse !== 'none') await act(async () => {
      choice = setPersonalSidebarView(collapse === 'project' ? { projects: { P: true } } : { groups: { 'P:root': true } })
        .then(() => 'accepted', () => 'refused');
    });
    const pending = useSessionUIStore.getState().sessionRevealIntent;
    if (collapse === 'project') expect(pending?.collapsedProjects.has('P')).toBe(true);
    if (collapse === 'group') expect(pending?.collapsedGroups.has('P:root')).toBe(true);
    fixture.readFailure = undefined; fixture.heldRead = undefined;
    await act(async () => { held.resolve(); if (choice) expect(await choice).toBe('refused'); }); await settle();
    expect(isPersonalSidebarAdmissionCurrent(ticket.preferenceAdmission)).toBe(false);
    expect(fixture.requests).toHaveLength(0); expect(revealed).toEqual([]);
    await act(async () => { expect((await readPersonalSidebarOwner(ticket.scope))?.subject).toBe(fixture.subjects[0]); });
    await act(async () => {
      expect(await setPersonalSidebarView({ projects: { P: false } }, ticket.preferenceAdmission)
        .then(() => 'accepted', () => 'refused')).toBe('refused');
    });
    expect(seen.projects.P).toBe(true);
    await act(async () => useSessionUIStore.getState().publishSessionReveal(ticket, node.session.id)); await settle();
    expect(fixture.requests).toHaveLength(0); expect(revealed).toEqual([]);
    expect(useSessionUIStore.getState().sessionRevealIntent).toBeNull();
    await open(); await settle(); expect(revealed).toEqual(['P:root']); expect(fixture.requests).toHaveLength(1);
  });
}

for (const collapse of ['project', 'group'] as const) {
  test(`failed durable ${collapse} collapse still cancels same-target reveal locally`, async () => {
    await reset(); await mount();
    let ticket!: SessionRevealTicket;
    await act(async () => { ticket = useSessionUIStore.getState().beginSessionReveal(); });
    fixture.refuse = true;
    await act(async () => {
      const patch = collapse === 'project' ? { projects: { P: true } } : { groups: { 'P:root': true } };
      expect(await setPersonalSidebarView(patch).then(() => 'accepted', () => 'refused')).toBe('refused');
    });
    fixture.refuse = false;
    await act(async () => useSessionUIStore.getState().setCurrentSession(node.session.id, node.session.directory, 'restore', ticket));
    await settle(); expect(revealed).toEqual([]); expect(fixture.requests).toHaveLength(1);
    expect(useSessionUIStore.getState().sessionRevealIntent).toBeNull();
    await open(); await settle(); expect(revealed).toEqual(['P:root']); expect(fixture.requests).toHaveLength(2);
  });
}
