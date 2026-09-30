import { afterAll, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { createSidebarOwnerFixture } from './sidebar-owner-fixture.js';
import { useHumanAuth } from './human-auth';
import { useAuthSessionStore } from './runtime-auth-expiry';
import { configureRuntimeUrlResolver } from './runtime-url';
import { captureRuntimeRequestScope, isRuntimeRequestScopeCurrent, switchRuntimeEndpoint } from './runtime-switch';
import { readPersonalSidebarOwner, setPersonalSidebarView, usePersonalSidebarView } from './sidebar-view';
import { recordTabShownSession, tabSessionNamespace } from './router/tab-session-route';

const win = new Window({ url: 'http://localhost/' });
const names = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const previous = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
const values = { window: win, document: win.document, IS_REACT_ACT_ENVIRONMENT: true };
for (const name of names) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
const fixture = await createSidebarOwnerFixture();
const { baseURL, subjects } = fixture;
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fixture.fetch);
configureRuntimeUrlResolver({ apiBaseUrl: baseURL });
useAuthSessionStore.getState().markAuthenticated();
useHumanAuth.setState({ enabled: true });
let seen: ReturnType<typeof usePersonalSidebarView>;
const Probe = () => { seen = usePersonalSidebarView(); return null; };
const settle = () => act(async () => { for (let i = 0; i < 8; i++) await new Promise(done => setTimeout(done, 5)); });
async function mounted(run: () => Promise<void>) {
  const root = createRoot(document.createElement('div'));
  try { await act(async () => root.render(<Probe />)); await settle(); await run(); }
  finally { await act(async () => root.unmount()); }
}
const save = (projects: Record<string, boolean>) => setPersonalSidebarView({ projects }).then(() => 'accepted', () => 'refused');
afterAll(async () => {
  fetchSpy.mockRestore(); await fixture.close();
  useHumanAuth.setState({ enabled: false }); configureRuntimeUrlResolver({});
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
  await win.happyDOM.close();
});

test('cookie-only A to B refusal clears A, cancels queued choices and renews tab owner authority', async () => {
  await mounted(async () => {
    await act(async () => { await setPersonalSidebarView({ projects: { privateA: false }, groups: { privateGroupA: false } }); });
    const oldScope = captureRuntimeRequestScope();
    const aNamespace = await tabSessionNamespace(oldScope);
    expect(aNamespace).toContain(subjects[0]);
    if (!aNamespace) throw new Error('Expected admitted A namespace');
    win.sessionStorage.setItem(aNamespace, 'A-shown-session');
    fixture.person(1); // Another tab changed the cookie. Do not refresh any client auth store.
    fixture.heldPatch = fixture.gate(); fixture.heldRead = fixture.gate();
    const beforeGets = fixture.gets;
    let first!: Promise<string>; let queued!: Promise<string>;
    await act(async () => { first = save({ rejectedA: true }); queued = save({ queuedA: true }); });
    await settle(); const beforeRequests = fixture.requests.length;
    await act(async () => { fixture.heldPatch?.resolve(); expect(await first).toBe('refused'); expect(await queued).toBe('refused'); });
    await settle();
    expect(seen.projects).toEqual({}); expect(seen.groups).toEqual({}); expect(seen.ready).toBe(false);
    expect(beforeRequests).toBe(2); // One accepted A seed and one refused A PATCH, never queued replay.
    expect(fixture.requests).toHaveLength(beforeRequests);
    expect(fixture.requests[1].owner.subject).toBe(subjects[0]);
    expect(fixture.gets).toBe(beforeGets + 1);
    expect(isRuntimeRequestScopeCurrent(oldScope)).toBe(false);
    expect(await readPersonalSidebarOwner(oldScope)).toBeNull();
    expect(await tabSessionNamespace(oldScope)).toBeNull();
    recordTabShownSession(oldScope, aNamespace, null);
    expect(win.sessionStorage.getItem(aNamespace)).toBe('A-shown-session');
    await act(async () => { fixture.heldRead?.resolve(); }); fixture.heldRead = undefined; fixture.heldPatch = undefined; await settle();
    const bScope = captureRuntimeRequestScope();
    expect(await readPersonalSidebarOwner(bScope)).toEqual({ issuer: baseURL, subject: subjects[1] });
    const bNamespace = await tabSessionNamespace(bScope);
    expect(bNamespace).toContain(subjects[1]);
    if (!bNamespace) throw new Error('Expected admitted B namespace');
    expect(win.sessionStorage.getItem(bNamespace)).toBeNull();
    expect(seen.projects).toEqual({}); expect(seen.ready).toBe(true);
    await act(async () => { expect(await save({ freshB: false })).toBe('accepted'); });
    expect((await fixture.stored(1)).projects).toEqual({ freshB: false });
    expect((await fixture.stored(0)).projects).toEqual({ privateA: false });
    expect((await fixture.stored(0)).groups).toEqual({ privateGroupA: false });
  });
});

test('ordinary 500 rolls back without hydration or auth generation change; later same-person action succeeds', async () => {
  fixture.person(1); fixture.requests = []; fixture.heldPatch = undefined; fixture.heldRead = undefined;
  await fixture.seed(1, { freshB: false });
  await mounted(async () => {
    const scope = captureRuntimeRequestScope(); const beforeGets = fixture.gets;
    fixture.refuse = true;
    await act(async () => { expect(await save({ freshB: true })).toBe('refused'); });
    expect(seen.projects).toEqual({ freshB: false });
    expect(isRuntimeRequestScopeCurrent(scope)).toBe(true); expect(fixture.gets).toBe(beforeGets);
    fixture.refuse = false;
    await act(async () => { expect(await save({ freshB: true })).toBe('accepted'); });
    expect((await fixture.stored(1)).projects).toEqual({ freshB: true });
    expect(await readPersonalSidebarOwner(scope)).toEqual({ issuer: baseURL, subject: subjects[1] });
  });
});

test('late B mismatch receipt cannot retire a newer A runtime or refresh its namespace', async () => {
  fixture.person(1); fixture.requests = [];
  await mounted(async () => {
    fixture.person(0); fixture.heldPatch = fixture.gate();
    let pending!: Promise<string>;
    await act(async () => { pending = save({ lateB: true }); }); await settle();
    await act(async () => switchRuntimeEndpoint({ apiBaseUrl: baseURL, runtimeKey: 'private-A' }));
    await settle(); const scope = captureRuntimeRequestScope(); const beforeGets = fixture.gets;
    await act(async () => { fixture.heldPatch?.resolve(); await pending; }); fixture.heldPatch = undefined; await settle();
    expect(isRuntimeRequestScopeCurrent(scope)).toBe(true); expect(fixture.gets).toBe(beforeGets);
    expect(seen.projects).toEqual({ privateA: false });
    expect(await readPersonalSidebarOwner(scope)).toEqual({ issuer: baseURL, subject: subjects[0] });
    expect(await tabSessionNamespace(scope)).toContain(subjects[0]);
    expect((await fixture.stored(0)).projects).toEqual({ privateA: false });
  });
});

test('owner mismatch also renews authority without a mounted sidebar subscriber', async () => {
  const oldScope = captureRuntimeRequestScope();
  expect((await readPersonalSidebarOwner(oldScope))?.subject).toBe(subjects[0]);
  fixture.person(1);
  const beforeGets = fixture.gets;
  expect(await save({ unmountedA: true })).toBe('refused');
  expect(isRuntimeRequestScopeCurrent(oldScope)).toBe(false);
  expect(await readPersonalSidebarOwner(oldScope)).toBeNull();
  const newScope = captureRuntimeRequestScope();
  expect((await readPersonalSidebarOwner(newScope))?.subject).toBe(subjects[1]);
  expect(fixture.gets).toBe(beforeGets + 1);
  expect((await fixture.stored(1)).projects).toEqual({ freshB: true });
});

test('a held newly admitted B hydration cannot publish after switching back to A', async () => {
  fixture.person(0);
  await act(async () => switchRuntimeEndpoint({ apiBaseUrl: baseURL, runtimeKey: 'A-hydration' }));
  await mounted(async () => {
    fixture.person(1);
    const bRead = fixture.gate(); fixture.heldRead = bRead;
    await act(async () => { expect(await save({ retiredA: true })).toBe('refused'); });
    await settle();
    const bScope = captureRuntimeRequestScope();
    expect(seen.ready).toBe(false); expect(seen.projects).toEqual({});
    fixture.person(0); fixture.heldRead = undefined;
    await act(async () => switchRuntimeEndpoint({ apiBaseUrl: baseURL, runtimeKey: 'A-return' }));
    await settle(); const aScope = captureRuntimeRequestScope();
    await act(async () => { bRead.resolve(); }); await settle();
    expect(isRuntimeRequestScopeCurrent(bScope)).toBe(false);
    expect(seen.projects).toEqual({ privateA: false });
    expect(seen.groups).toEqual({ privateGroupA: false });
    expect((await readPersonalSidebarOwner(aScope))?.subject).toBe(subjects[0]);
    expect(await tabSessionNamespace(bScope)).toBeNull();
    expect(await tabSessionNamespace(aScope)).toContain(subjects[0]);
  });
});
