import { afterAll, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { createSidebarOwnerFixture } from './sidebar-owner-fixture.js';
import { useHumanAuth } from './human-auth';
import { useAuthSessionStore } from './runtime-auth-expiry';
import { configureRuntimeUrlResolver } from './runtime-url';
import { captureRuntimeRequestScope } from './runtime-switch';
import { readPersonalSidebarOwner, usePersonalSidebarView } from './sidebar-view';

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
    await act(async () => expect((await readPersonalSidebarOwner(scope))?.subject).toBe(fixture.subjects[1]));
    await settle();
    expect(seen.projects).toEqual({ privateB: false });
    expect(seen.projects.privateA).toBeUndefined();
  });
});

test('same-person revalidation preserves the cached personal view', async () => {
  fixture.person(1);
  await mounted(async () => {
    const scope = captureRuntimeRequestScope();
    expect((await readPersonalSidebarOwner(scope))?.subject).toBe(fixture.subjects[1]);
    expect(seen.projects).toEqual({ privateB: false });
  });
});
