import { afterAll, beforeEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { toast } from 'sonner';
import { useHumanAuth } from './human-auth';
import { useAuthSessionStore } from './runtime-auth-expiry';
import { configureRuntimeUrlResolver } from './runtime-url';
import { resetRuntimeAuthGeneration } from './runtime-auth';
import { switchRuntimeEndpoint } from './runtime-switch';
import { setPersonalSidebarView, subscribePersonalSidebarViewMutations, usePersonalSidebarView } from './sidebar-view';

const win = new Window({ url: 'https://ui.example.test/' });
const values = { window: win, document: win.document, IS_REACT_ACT_ENVIRONMENT: true };
const names = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const previous = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
for (const name of names) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
const fetchSpy = spyOn(globalThis, 'fetch');
let failureNotices = 0;
const toastSpy = spyOn(toast, 'error').mockImplementation(() => { failureNotices++; return 'fixture'; });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
let getDelay: Promise<void> | undefined;
let patchDelay: Promise<void> | undefined;
let getFails: false | number | 'network' | 'body' = false;
let owner = 'a';
let status: (number | 'network')[] = [];
let requests: { owner: { issuer: string; subject: string }; projects?: Record<string, boolean>; groups?: Record<string, boolean> }[] = [];
let seen: ReturnType<typeof usePersonalSidebarView>;
const Probe = () => { seen = usePersonalSidebarView(); return null; };
const settle = () => act(async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)); });
beforeEach(() => {
  requests = []; status = []; getDelay = undefined; patchDelay = undefined; getFails = false; owner = 'a';
  failureNotices = 0;
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example.test' });
  resetRuntimeAuthGeneration();
  useAuthSessionStore.setState({ state: 'ok' });
  useHumanAuth.setState({ enabled: true });
  fetchSpy.mockImplementation(async (input, init) => {
    if (!String(input).endsWith('/api/config/sidebar-view')) return Response.json({});
    if (init?.method === 'PATCH') {
      requests.push(JSON.parse(String(init.body)));
      const result = status.shift() ?? 200;
      await patchDelay;
      if (result === 'network') throw new Error('Connection lost');
      return Response.json({}, { status: result });
    }
    const subject = owner;
    const failed = getFails;
    await getDelay;
    if (failed === 'network') throw new Error('Connection lost');
    if (failed === 'body') return new Response('not JSON');
    return failed ? Response.json({}, { status: failed }) : Response.json({ owner: { issuer: 'issuer', subject }, projects: { p: true }, groups: {} });
  });
});
afterAll(async () => {
  fetchSpy.mockRestore(); toastSpy.mockRestore(); useHumanAuth.setState({ enabled: false });
  configureRuntimeUrlResolver({});
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
  await win.happyDOM.close();
});
async function mounted(run: () => Promise<void>) {
  const root = createRoot(document.createElement('div'));
  try { await act(async () => root.render(<Probe />)); await run(); }
  finally { await act(async () => root.unmount()); }
}
const save = (projects: Record<string, boolean>) => setPersonalSidebarView({ projects }).catch(() => undefined);
for (const failure of [500, 'network'] as const) test(`PATCH ${failure} rolls back pre-hydration choice and notifies`, async () => {
  const gate = deferred(); getDelay = gate.promise; status = [failure];
  await mounted(async () => {
    let pending!: Promise<void>;
    await act(async () => { pending = save({ p: false }); });
    expect(seen.projects.p).toBe(false);
    await act(async () => { gate.resolve(); await pending; });
    expect(seen.projects.p).toBe(true);
    expect(seen.ready).toBe(true);
    expect(failureNotices).toBe(1);
  });
});

for (const first of [500, 200]) test(`queued same-key failures retain confirmed choice, first status ${first}`, async () => {
  const gate = deferred(); patchDelay = gate.promise; status = [first, 500];
  await mounted(async () => {
    await settle();
    let one!: Promise<void>; let two!: Promise<void>;
    await act(async () => { one = save({ p: false }); two = save({ p: true }); });
    await settle(); expect(requests).toHaveLength(1);
    await act(async () => { gate.resolve(); await Promise.all([one, two]); });
    expect(seen.projects.p).toBe(first === 200 ? false : true);
    expect(requests).toHaveLength(2);
    expect(requests.map(request => request.projects)).toEqual([{ p: false }, { p: true }]);
  });
});

test('sparse serialized saves preserve unrelated newer choices and explicit false', async () => {
  const gate = deferred(); patchDelay = gate.promise; status = [500, 200];
  await mounted(async () => {
    await settle();
    let one!: Promise<void>; let two!: Promise<void>;
    await act(async () => { one = save({ p: false }); two = setPersonalSidebarView({ groups: { g: false }, projects: { q: true } }); });
    await act(async () => { gate.resolve(); await Promise.all([one, two]); });
    expect(seen.projects).toEqual({ p: true, q: true }); expect(seen.groups).toEqual({ g: false });
    expect(requests[1]).toEqual({ owner: { issuer: 'issuer', subject: 'a' }, projects: { q: true }, groups: { g: false } });
  });
});

for (const failure of [404, 500, 'network', 'body'] as const) test(`GET ${failure} is silent and cannot authorize PATCH`, async () => {
  getFails = failure;
  await mounted(async () => {
    await settle(); expect(seen.ready).toBe(false); expect(failureNotices).toBe(0);
    await act(async () => { await save({ p: false }); });
    expect(seen.ready).toBe(false); expect(requests).toHaveLength(0); expect(seen.projects).toEqual({});
    expect(failureNotices).toBe(0);
  });
});

test('PATCH 409 notifies, rejects, and recovers without replaying the old choice', async () => {
  status = [409];
  await mounted(async () => {
    await settle(); const admission = seen.admission;
    await act(async () => { await expect(setPersonalSidebarView({ projects: { p: false } })).rejects.toThrow('save failed (409)'); });
    await settle(); expect(failureNotices).toBe(1); expect(requests).toHaveLength(1);
    expect(seen.admission).not.toBe(admission); expect(seen.ready).toBe(true); expect(seen.projects.p).toBe(true);
  });
});
test('lock and verified recovery retire A read and action without retargeting B', async () => {
  const gate = deferred(); getDelay = gate.promise;
  await mounted(async () => {
    let pending!: Promise<void>;
    await act(async () => { pending = save({ p: false }); });
    await act(async () => useAuthSessionStore.getState().markReauthenticating());
    expect(seen.projects).toEqual({}); expect(seen.ready).toBe(false);
    owner = 'b'; getDelay = undefined;
    await act(async () => useAuthSessionStore.getState().markAuthenticated()); await settle();
    await act(async () => { gate.resolve(); await pending; });
    expect(requests).toHaveLength(0); expect(seen.projects.p).toBe(true);
    await act(async () => { await save({ p: false }); });
    expect(requests[0]?.owner.subject).toBe('b');
  });
});

test('dispatched A patch keeps expected A owner and cannot publish into B', async () => {
  const gate = deferred(); patchDelay = gate.promise; status = [500];
  await mounted(async () => {
    await settle(); let pending!: Promise<void>;
    await act(async () => { pending = save({ p: false }); }); await settle();
    expect(requests[0]?.owner.subject).toBe('a');
    await act(async () => useAuthSessionStore.getState().markReauthenticating());
    owner = 'b';
    await act(async () => useAuthSessionStore.getState().markAuthenticated()); await settle();
    await act(async () => { gate.resolve(); await pending; });
    expect(seen.projects.p).toBe(true); expect(failureNotices).toBe(0);
  });
});

test('late A read and save rejection do not toast in B', async () => {
  const gate = deferred(); getDelay = gate.promise; getFails = 500;
  await mounted(async () => {
    let pending!: Promise<void>;
    await act(async () => { pending = save({ p: false }); });
    await act(async () => useAuthSessionStore.getState().markReauthenticating());
    owner = 'b'; getDelay = undefined; getFails = false;
    await act(async () => useAuthSessionStore.getState().markAuthenticated()); await settle();
    await act(async () => { gate.resolve(); await pending; });
    expect(seen.projects.p).toBe(true); expect(failureNotices).toBe(0); expect(requests).toHaveLength(0);
  });
});

test('endpoint switch retires queued work and GET snapshot even when project IDs match', async () => {
  const gate = deferred(); getDelay = gate.promise;
  await mounted(async () => {
    let pending!: Promise<void>; let rejected = false;
    await act(async () => { pending = setPersonalSidebarView({ projects: { p: false } }).catch(() => { rejected = true; }); });
    owner = 'b'; getDelay = undefined;
    await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime-b.example.test' })); await settle();
    await act(async () => { gate.resolve(); await pending; });
    expect(rejected).toBe(true); expect(requests).toHaveLength(0);
    expect(seen.projects.p).toBe(true); expect(failureNotices).toBe(0);
    await act(async () => { await save({ p: false }); });
    expect(requests[0]?.owner.subject).toBe('b');
  });
});

test('mutation subscription emits exact explicit no-op choices, never hydration or locked actions', async () => {
  const patches: Parameters<typeof setPersonalSidebarView>[0][] = [];
  const release = subscribePersonalSidebarViewMutations(patch => patches.push(patch));
  try { await mounted(async () => {
    await settle(); expect(patches).toEqual([]);
    await act(async () => { await save({ p: true }); await save({ p: true }); });
    expect(patches).toEqual([{ projects: { p: true } }, { projects: { p: true } }]);
    await act(async () => useAuthSessionStore.getState().markExpired());
    await act(async () => { await save({ p: false }); }); expect(patches).toHaveLength(2);
  }); } finally { release(); }
});
