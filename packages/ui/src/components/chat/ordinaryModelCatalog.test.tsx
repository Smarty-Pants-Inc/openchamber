import React, { act } from 'react';
import { afterAll, afterEach, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => Response.json({ home: '/home/fixture' });
// Base UI detects DOM support at import time.
const win = new Window({ url: 'https://code.example.test' });
Object.assign(globalThis, { window: win, document: win.document, navigator: win.navigator,
  HTMLElement: win.HTMLElement, Element: win.Element, Node: win.Node, localStorage: win.localStorage,
  getComputedStyle: win.getComputedStyle.bind(win), requestAnimationFrame: win.requestAnimationFrame.bind(win),
  cancelAnimationFrame: win.cancelAnimationFrame.bind(win), ResizeObserver: win.ResizeObserver,
  CustomEvent: win.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
const { OrdinaryModelControls } = await import('./OrdinaryModelControls');
const { I18nProvider } = await import('@/lib/i18n');
const { selectProvidersForDirectory, useConfigStore } = await import('@/stores/useConfigStore');
import { deferred } from '@/lib/runtime-isolation-fixture';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import type { Provider } from '@opencode-ai/sdk/v2';

const model = (id: string): Provider['models'][string] => ({
  id, providerID: 'p', name: id, family: 'fixture', api: { id, url: '', npm: '' },
  capabilities: { temperature: false, reasoning: false, attachment: false, toolcall: false,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false }, interleaved: false },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 1000, output: 100 }, status: 'active', options: {}, headers: {}, release_date: '',
});
const provider = (...ids: string[]): Provider => ({ id: 'p', name: 'P', source: 'custom', env: [], options: {},
  models: Object.fromEntries(ids.map(id => [id, model(id)])) });
afterAll(async () => { await win.happyDOM.close(); });
afterEach(() => { globalThis.fetch = originalFetch; });

function mount() {
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://code.example.test' });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const commits: string[][] = [];
  function Probe() {
    React.useLayoutEffect(() => { commits.push([...host.querySelectorAll('[role="combobox"]')].map(el => el.textContent ?? '')); });
    return null;
  }
  const render = (sessionId: string, modelID = 'common') => act(async () => {
    root.render(<I18nProvider><OrdinaryModelControls target={{ sessionId, directory: '/repo' }}
      state={{ generation: sessionId, sequence: 1, thinkingLevel: null,
        model: { providerID: 'p', modelID, name: modelID } }} /><Probe /></I18nProvider>);
  });
  const open = () => act(async () => {
    host.querySelector<HTMLButtonElement>('[role="combobox"]')?.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  const options = () => [...document.querySelectorAll('[role="option"]')].map(el => el.textContent);
  return { render, open, options, commits, host, unmount: async () => {
    await act(async () => root.unmount()); host.remove();
  } };
}

// smarty-code#1138: the directory catalog may belong to whichever native session answered first.
test('the menu uses only its session catalog; switching refetches and never paints the previous picker', async () => {
  const x = provider('common', 'x-only'), y = provider('common', 'y-only');
  useConfigStore.setState({ activeDirectoryKey: '__global__', providers: [{ ...y, models: Object.values(y.models) }] });
  const requests: URL[] = [];
  const held = deferred<Response>();
  globalThis.fetch = async input => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url);
    return url.searchParams.get('session') === 'X' ? Response.json({ providers: [x], default: {} }) : held.promise;
  };
  const view = mount();
  try {
    expect(selectProvidersForDirectory(useConfigStore.getState(), '/repo').flatMap(p => p.models.map(m => m.id)))
      .toEqual(['common', 'y-only']);
    await view.render('X');
    await view.open();
    expect(view.options()).toEqual(['common', 'x-only']);
    expect(requests.map(url => [url.pathname, url.searchParams.get('directory'), url.searchParams.get('session')]))
      .toEqual([['/api/config/providers', '/repo', 'X']]);
    view.commits.length = 0;
    await view.render('Y');
    expect(view.commits[0]).toEqual([]);
    expect(view.host.querySelector('[role="combobox"]')).toBeNull();
    expect(requests.at(-1)?.searchParams.get('session')).toBe('Y');
    await act(async () => { held.resolve(Response.json({ providers: [y], default: {} })); });
    await view.open();
    expect(view.options()).toEqual(['common', 'y-only']);
  } finally { await view.unmount(); }
});

test('a missing current model refreshes the session catalog once, not the project store', async () => {
  let calls = 0;
  globalThis.fetch = async input => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.searchParams.get('session')).toBe('X');
    calls += 1;
    return Response.json({ providers: [provider('other')], default: {} });
  };
  const view = mount();
  try {
    await view.render('X');
    expect(calls).toBe(2);
    expect(view.host.querySelector('[role="combobox"]')).toBeNull();
    await view.render('X');
    expect(calls).toBe(2); // Still missing: no retry loop.
  } finally { await view.unmount(); }
});

test('an unknown session fails closed without offering the shared catalog or retrying the error', async () => {
  const shared = provider('common', 'y-only');
  useConfigStore.setState({ activeDirectoryKey: '__global__', providers: [{ ...shared, models: Object.values(shared.models) }] });
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json({ error: 'Unknown session' }, { status: 404 }); };
  const view = mount();
  try {
    await view.render('unknown');
    expect(calls).toBe(1);
    expect(view.host.textContent).toContain('Unavailable');
    expect(view.host.querySelector('[role="combobox"]')).toBeNull();
    expect(view.host.textContent).not.toContain('y-only');
  } finally { await view.unmount(); }
});

test('a late previous-session response cannot replace the selected session options', async () => {
  const old = deferred<Response>();
  const calls: string[] = [];
  globalThis.fetch = async input => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const session = url.searchParams.get('session') ?? '';
    calls.push(session);
    return session === 'X' ? old.promise : Response.json({ providers: [provider('common', 'y-only')], default: {} });
  };
  const view = mount();
  try {
    await view.render('X');
    expect(view.host.textContent).toContain('Loading');
    await view.render('Y');
    expect(calls).toEqual(['X', 'Y']);
    await act(async () => { old.resolve(Response.json({ providers: [provider('common', 'x-only')], default: {} })); });
    await view.open();
    expect(view.options()).toEqual(['common', 'y-only']);
  } finally { await view.unmount(); }
});

test('session requests cannot share a project request in flight and preserve encoded directory/session values', async () => {
  const { opencodeClient } = await import('@/lib/opencode/client');
  const pendingProject = deferred<Response>();
  const directory = '/repo/space +?#', sessionId = 'X/+?#';
  const requests: URL[] = [];
  globalThis.fetch = async input => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url);
    return url.searchParams.has('session')
      ? Response.json({ providers: [provider('x-only')], default: {} }) : pendingProject.promise;
  };
  const project = opencodeClient.getProvidersForConfig(directory);
  const session = opencodeClient.getProvidersForConfig(directory, sessionId);
  pendingProject.resolve(Response.json({ providers: [provider('y-only')], default: {} }));
  const [projectCatalog, sessionCatalog] = await Promise.all([project, session]);
  expect(Object.keys(projectCatalog.providers[0].models)).toEqual(['y-only']);
  expect(Object.keys(sessionCatalog.providers[0].models)).toEqual(['x-only']);
  expect(requests.map(url => [url.searchParams.get('directory'), url.searchParams.get('session')]))
    .toEqual([[directory, null], [directory, sessionId]]);
});
