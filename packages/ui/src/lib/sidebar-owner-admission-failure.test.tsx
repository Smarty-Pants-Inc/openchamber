import { afterAll, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { toast } from 'sonner';
import { createSidebarOwnerFixture } from './sidebar-owner-fixture.js';
import { useHumanAuth } from './human-auth';
import { useAuthSessionStore } from './runtime-auth-expiry';
import { configureRuntimeUrlResolver } from './runtime-url';
import { captureRuntimeRequestScope, isRuntimeRequestScopeCurrent, switchRuntimeEndpoint } from './runtime-switch';
import { readPersonalSidebarOwner, setPersonalSidebarView, subscribePersonalSidebarViewMutations, usePersonalSidebarView } from './sidebar-view';

const win = new Window({ url: 'http://localhost/' });
const names = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const previous = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
const values = { window: win, document: win.document, IS_REACT_ACT_ENVIRONMENT: true };
for (const name of names) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
const fixture = await createSidebarOwnerFixture();
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fixture.fetch);
let notices = 0;
const toastSpy = spyOn(toast, 'error').mockImplementation(() => { notices++; return 'fixture'; });
configureRuntimeUrlResolver({ apiBaseUrl: fixture.baseURL });
useAuthSessionStore.getState().markAuthenticated();
useHumanAuth.setState({ enabled: true });
let seen: ReturnType<typeof usePersonalSidebarView>;
const Probe = () => { seen = usePersonalSidebarView(); return null; };
const settle = () => act(async () => { for (let i = 0; i < 8; i++) await new Promise(done => setTimeout(done, 5)); });
const save = (patch: Parameters<typeof setPersonalSidebarView>[0]) => setPersonalSidebarView(patch).then(() => 'accepted', () => 'refused');
async function mounted(run: () => Promise<void>) {
  const root = createRoot(document.createElement('div'));
  try { await act(async () => root.render(<Probe />)); await settle(); await run(); }
  finally { await act(async () => root.unmount()); }
}
afterAll(async () => {
  fetchSpy.mockRestore(); toastSpy.mockRestore(); await fixture.close();
  useHumanAuth.setState({ enabled: false }); configureRuntimeUrlResolver({});
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
  await win.happyDOM.close();
});

for (const failure of ['storage', 'transport'] as const) for (const kind of ['cross-key', 'same-key'] as const) {
  test(`failed ownerless ${failure} ${kind} admission retires both choices and owner reader; fresh B saves`, async () => {
    fixture.person(0); fixture.requests = []; notices = 0;
    const beforeA = await fixture.stored(0); const beforeB = await fixture.stored(1);
    fixture.readFailure = failure;
    const held = fixture.gate(); fixture.heldRead = held;
    await mounted(async () => {
      expect(seen.ready).toBe(false);
      const scope = captureRuntimeRequestScope();
      const beforeGets = fixture.gets;
      const choices: Parameters<typeof setPersonalSidebarView>[0][] = [];
      const release = subscribePersonalSidebarViewMutations(patch => choices.push(patch));
      const firstPatch = { projects: { oldA: true } };
      const secondPatch = kind === 'cross-key' ? { groups: { oldAGroup: false } } : { projects: { oldA: false } };
      let first!: Promise<string>; let second!: Promise<string>; let ownerReader!: Promise<string>;
      try {
        await act(async () => {
          ownerReader = readPersonalSidebarOwner(scope).then(owner => owner ? 'admitted' : 'refused', () => 'refused');
          first = save(firstPatch); second = save(secondPatch);
        });
        expect(seen.projects).toEqual({ oldA: kind === 'cross-key' });
        expect(seen.groups).toEqual(kind === 'cross-key' ? { oldAGroup: false } : {});
        expect(choices).toEqual([firstPatch, secondPatch]);
        fixture.person(1); // Cookie-only switch in another tab, no client auth event.
        fixture.readFailure = undefined; fixture.heldRead = undefined;
        let results: string[] = [];
        await act(async () => { held.resolve(); results = await Promise.all([first, second, ownerReader]); });
        await settle();
        expect(results).toEqual(['refused', 'refused', 'refused']);
        expect(seen.projects).toEqual({}); expect(seen.groups).toEqual({}); expect(seen.ready).toBe(false);
        expect(fixture.requests).toHaveLength(0); expect(fixture.gets).toBe(beforeGets);
        expect(await fixture.stored(0)).toEqual(beforeA);
        expect(await fixture.stored(1)).toEqual(beforeB);
        expect(notices).toBe(0); expect(isRuntimeRequestScopeCurrent(scope)).toBe(true);
        await act(async () => { expect(await save({ projects: { freshB: false } })).toBe('accepted'); });
        expect((await fixture.stored(1)).projects).toEqual({ freshB: false });
        expect((await fixture.stored(1)).groups).toEqual({});
        expect((await readPersonalSidebarOwner(scope))?.subject).toBe(fixture.subjects[1]);
        expect(fixture.requests).toHaveLength(1); expect(fixture.requests[0].owner.subject).toBe(fixture.subjects[1]);
      } finally { release(); held.resolve(); }
    });
  });
}

test('healthy same-person ownerless admission saves two different choices', async () => {
  fixture.person(0); fixture.requests = []; fixture.readFailure = undefined; notices = 0;
  const held = fixture.gate(); fixture.heldRead = held;
  await mounted(async () => {
    expect(seen.ready).toBe(false);
    let first!: Promise<string>; let second!: Promise<string>;
    await act(async () => { first = save({ projects: { healthyA: false } }); second = save({ groups: { healthyGroupA: true } }); });
    expect(seen.projects).toEqual({ healthyA: false }); expect(seen.groups).toEqual({ healthyGroupA: true });
    await act(async () => { held.resolve(); expect(await Promise.all([first, second])).toEqual(['accepted', 'accepted']); });
    fixture.heldRead = undefined;
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests.map(request => request.owner.subject)).toEqual([fixture.subjects[0], fixture.subjects[0]]);
    expect((await fixture.stored(0)).projects).toEqual({ healthyA: false });
    expect((await fixture.stored(0)).groups).toEqual({ healthyGroupA: true }); expect(notices).toBe(0);
  });
});

test('failed old owner reader joins only an independently running same-scope successor', async () => {
  fixture.person(0); notices = 0;
  await fixture.seed(1, { freshB: false });
  const beforeB = await fixture.stored(1); fixture.requests = []; fixture.readFailure = 'storage';
  const heldA = fixture.gate(); fixture.heldRead = heldA;
  await mounted(async () => {
    const scope = captureRuntimeRequestScope();
    const reader = readPersonalSidebarOwner(scope);
    const heldB = fixture.gate();
    fixture.person(1); fixture.readFailure = undefined; fixture.heldRead = heldB;
    const beforeGets = fixture.gets;
    // A same-scope auth observation starts a successor load independently.
    await act(async () => useHumanAuth.setState({ enabled: true })); await settle();
    expect(isRuntimeRequestScopeCurrent(scope)).toBe(true); expect(fixture.gets).toBe(beforeGets + 1);
    let completed = false;
    const result = reader.then(owner => { completed = true; return owner; });
    await act(async () => { heldA.resolve(); }); await settle();
    expect(completed).toBe(false); expect(fixture.gets).toBe(beforeGets + 1);
    await act(async () => { heldB.resolve(); expect((await result)?.subject).toBe(fixture.subjects[1]); });
    fixture.heldRead = undefined;
    expect(seen.ready).toBe(true); expect(seen.projects).toEqual(beforeB.projects); expect(seen.groups).toEqual(beforeB.groups);
    expect(notices).toBe(0); expect(fixture.requests).toHaveLength(0);
  });
});

for (const failure of ['storage', 'transport'] as const) {
  test(`stale A ${failure} admission cannot retire hydrated B or toast`, async () => {
    fixture.person(0); fixture.requests = []; notices = 0;
    await fixture.seed(1, { freshB: false });
    const beforeB = await fixture.stored(1); fixture.requests = [];
    fixture.readFailure = failure;
    const held = fixture.gate(); fixture.heldRead = held;
    await mounted(async () => {
      let first!: Promise<string>; let second!: Promise<string>;
      await act(async () => { first = save({ projects: { staleA: true } }); second = save({ groups: { staleGroupA: true } }); });
      fixture.person(1); fixture.readFailure = undefined; fixture.heldRead = undefined;
      await act(async () => switchRuntimeEndpoint({ apiBaseUrl: fixture.baseURL, runtimeKey: `B-${failure}` }));
      await settle(); const scope = captureRuntimeRequestScope(); const beforeGets = fixture.gets;
      expect(seen.ready).toBe(true); expect(seen.projects).toEqual(beforeB.projects);
      await act(async () => { held.resolve(); expect(await Promise.all([first, second])).toEqual(['refused', 'refused']); });
      await settle();
      expect(seen.ready).toBe(true); expect(seen.projects).toEqual(beforeB.projects); expect(seen.groups).toEqual(beforeB.groups);
      expect(notices).toBe(0); expect(fixture.requests).toHaveLength(0); expect(fixture.gets).toBe(beforeGets);
      expect(isRuntimeRequestScopeCurrent(scope)).toBe(true);
      expect((await readPersonalSidebarOwner(scope))?.subject).toBe(fixture.subjects[1]);
    });
  });
}
