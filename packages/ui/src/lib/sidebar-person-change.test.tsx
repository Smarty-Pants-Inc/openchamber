import { afterAll, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { createSidebarOwnerFixture } from './sidebar-owner-fixture.js';
import { useHumanAuth } from './human-auth';
import { useAuthSessionStore } from './runtime-auth-expiry';
import { configureRuntimeUrlResolver } from './runtime-url';
import { captureRuntimeRequestScope, isRuntimeRequestScopeCurrent } from './runtime-switch';
import { readPersonalSidebarOwner, usePersonalSidebarView } from './sidebar-view';
import { recordTabShownSession, tabSessionNamespace } from './router/tab-session-route';
import { runtimeFetch } from './runtime-fetch';
import { useSessionUIStore } from '@/sync/session-ui-store';

const win = new Window({ url: 'http://localhost/' });
const names = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const previous = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
for (const name of names) Object.defineProperty(globalThis, name, { value: name === 'window' ? win : name === 'document' ? win.document : true, configurable: true, writable: true });
const fixture = await createSidebarOwnerFixture();
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fixture.fetch);
configureRuntimeUrlResolver({ apiBaseUrl: fixture.baseURL });
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

afterAll(async () => {
  fetchSpy.mockRestore(); await fixture.close(); useHumanAuth.setState({ enabled: false }); configureRuntimeUrlResolver({});
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
  await win.happyDOM.close();
});

test('retires a cached personal view when a later read admits a different person', async () => {
  fixture.person(0); await fixture.seed(0, { privateA: true });
  fixture.person(1); await fixture.seed(1, { privateB: false });
  fixture.person(0);
  await mounted(async () => {
    expect(seen.projects).toEqual({ privateA: true });
    const scope = captureRuntimeRequestScope();
    fixture.person(1); // Cookie-only switch in another tab; this tab's auth state is unchanged.
    await act(async () => expect(await readPersonalSidebarOwner(scope)).toBeNull());
    expect(isRuntimeRequestScopeCurrent(scope)).toBe(false);
    const bScope = captureRuntimeRequestScope();
    await act(async () => expect((await readPersonalSidebarOwner(bScope))?.subject).toBe(fixture.subjects[1]));
    await settle();
    expect(seen.projects).toEqual({ privateB: false });
    expect(seen.projects.privateA).toBeUndefined();
  });
});

test('owner-changing read retires an in-flight A runtime request and A tab receipts', async () => {
  fixture.person(0); useAuthSessionStore.getState().markAuthenticated();
  await mounted(async () => {
    const aScope = captureRuntimeRequestScope();
    let aNamespace: string | null = null;
    await act(async () => { aNamespace = await tabSessionNamespace(aScope); });
    if (!aNamespace) throw new Error('Expected admitted A namespace');
    win.sessionStorage.setItem(aNamespace, 'A-shown-session');
    useSessionUIStore.getState().setCurrentSession(null);
    const aGate = fixture.gate(); fixture.heldRead = aGate;
    // A separate runtime read must also lose authority, not only sidebar hydration.
    const aRequest = runtimeFetch('/api/config/sidebar-view').then(response => response.json()).then(
      () => 'accepted', () => 'refused');
    let result = '';
    try {
      await settle();
      fixture.person(1); fixture.heldRead = undefined;
      await act(async () => { await readPersonalSidebarOwner(aScope); });
      await settle();
      await act(async () => { aGate.resolve(); result = await aRequest; });
      expect(result).toBe('refused');
      expect(isRuntimeRequestScopeCurrent(aScope)).toBe(false);
      expect(await tabSessionNamespace(aScope)).toBeNull();
      recordTabShownSession(aScope, aNamespace, null);
      expect(win.sessionStorage.getItem(aNamespace)).toBe('A-shown-session');
      const bScope = captureRuntimeRequestScope();
      let bNamespace: string | null = null;
      await act(async () => { bNamespace = await tabSessionNamespace(bScope); });
      expect(bNamespace).toContain(fixture.subjects[1]);
      expect(bNamespace).not.toBe(aNamespace);
      expect(seen.projects).toEqual({ privateB: false });
    } finally {
      fixture.heldRead = undefined;
      await act(async () => { aGate.resolve(); await aRequest; });
    }
  });
});

for (const trigger of ['owner', 'focus'] as const) test(`forced ${trigger} revalidation starts a fresh B read while A is still in flight`, async () => {
  fixture.person(0); useAuthSessionStore.getState().markAuthenticated();
  await mounted(async () => {
    const aScope = captureRuntimeRequestScope();
    const aGate = fixture.gate(); fixture.heldRead = aGate;
    const aRead = readPersonalSidebarOwner(aScope);
    let bRead = Promise.resolve();
    try {
      await settle();
      const readsWithAInFlight = fixture.gets;
      fixture.person(1); fixture.heldRead = undefined;
      await act(async () => {
        if (trigger === 'owner') bRead = readPersonalSidebarOwner(aScope).then(() => undefined);
        else win.dispatchEvent(new win.Event('focus'));
      });
      await settle();
      expect(fixture.gets).toBe(readsWithAInFlight + 1);
      expect(seen.projects).toEqual({ privateB: false });
      expect(isRuntimeRequestScopeCurrent(aScope)).toBe(false);
      await act(async () => { aGate.resolve(); expect(await aRead).toBeNull(); });
      await settle();
      expect(seen.projects).toEqual({ privateB: false });
    } finally {
      fixture.heldRead = undefined;
      await act(async () => { aGate.resolve(); await Promise.all([aRead, bRead]); });
    }
  });
});

test('same-person revalidation preserves the cached personal view', async () => {
  fixture.person(1);
  await mounted(async () => {
    const scope = captureRuntimeRequestScope();
    await act(async () => expect((await readPersonalSidebarOwner(scope))?.subject).toBe(fixture.subjects[1]));
    expect(isRuntimeRequestScopeCurrent(scope)).toBe(true);
    expect(seen.projects).toEqual({ privateB: false });
  });
});
