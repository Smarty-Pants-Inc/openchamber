import test from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

Server.prototype.listen = () => { throw new Error('Offline dialog test forbids listeners'); };
const { Window } = await import('happy-dom');
const window = new Window({ url: 'https://offline-dialog.invalid' });
for (const key of ['document', 'navigator', 'localStorage', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
  'Element', 'Node', 'NodeFilter', 'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event', 'MouseEvent']) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
}
Object.assign(globalThis, { window, IS_REACT_ACT_ENVIRONMENT: true,
  getComputedStyle: window.getComputedStyle.bind(window), requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window) });
let filesystemHome = '', listingStatus = 200;
const requests = [], unexpected = [];
const owned = '/offline/owned';
const intercept = async (input, init) => {
  const request = new Request(input instanceof Request ? input : new URL(input, window.location.href), init);
  const url = new URL(request.url);
  requests.push({ method: request.method, path: url.pathname, directory: url.searchParams.get('path') });
  assert.equal(url.origin, window.location.origin, 'no foreign-origin request');
  if (url.pathname === '/api/fs/home') return filesystemHome ? Response.json({ home: filesystemHome }) : Response.json({ error: 'Offline unavailable' }, { status: 503 });
  if (url.pathname === '/api/fs/list') return listingStatus === 200 ? Response.json({ entries: [] }) : Response.json({ error: 'Offline permission refusal', reason: 'os-permission' }, { status: listingStatus });
  if (url.pathname === '/api/config/settings') return Response.json({});
  if (url.pathname === '/api/git/identities') return Response.json([]);
  if (url.pathname === '/api/git/global-identity') return Response.json({ userName: '', userEmail: '' });
  if (['/api/path', '/api/project/current', '/api/session-folders'].includes(url.pathname)) return Response.json({ error: 'Offline unavailable' }, { status: 503 });
  unexpected.push({ method: request.method, path: url.pathname });
  return Response.json({ error: 'Unconfigured offline request' }, { status: 503 });
};
globalThis.fetch = intercept;
window.fetch = intercept;
const { createServer } = await import('vite');
const ui = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cacheDir = await mkdtemp(join(tmpdir(), 'oc-directory-preconditions-'));
const loader = await createServer({ configFile: false, root: resolve(ui, '..'), cacheDir,
  appType: 'custom', define: { process: 'undefined' }, resolve: { alias: { '@': ui } },
  server: { middlewareMode: true, watch: null, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
const load = path => loader.ssrLoadModule(`${ui}/${path}`);
const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useDirectoryStore } = await load('stores/useDirectoryStore.ts');
const { useProjectsStore } = await load('stores/useProjectsStore.ts');
const { DirectoryExplorerDialog } = await load('components/session/DirectoryExplorerDialog.tsx');
const { I18nProvider } = await load('lib/i18n/index.ts');
const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);
const tick = () => new Promise(resolve => setTimeout(resolve, 35));
async function mount(home, member) {
  await act(async () => { root.render(null); await tick(); });
  filesystemHome = home;
  useDirectoryStore.setState({ homeDirectory: home, currentDirectory: '', isHomeReady: Boolean(home), hasPersistedDirectory: false });
  useProjectsStore.setState({ projects: member ? [{ id: 'owned', path: owned, label: 'Owned', addedAt: 1 }] : [], activeProjectId: null });
  await act(async () => { root.render(React.createElement(I18nProvider, null,
    React.createElement(DirectoryExplorerDialog, { open: true, onOpenChange() {} }))); await tick(); });
  await act(tick);
  requests.length = 0;
}
async function typePath(value) {
  const input = document.querySelector('input[placeholder="Enter path or select from tree..."]');
  assert.ok(input, 'actual dialog input mounted');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await tick();
  });
  await act(tick);
  const button = [...document.querySelectorAll('[role="dialog"] button')].find(node => /^(Add project|Already added|Create & add)/.test(node.textContent));
  assert.ok(button, 'actual submit button mounted');
  console.log(JSON.stringify({ evidence: 'actual-dialog-precondition', input: input.value,
    home: useDirectoryStore.getState().homeDirectory,
    member: useProjectsStore.getState().projects.some(project => project.path === owned),
    label: button.textContent, disabled: button.disabled,
    browse: requests.filter(request => request.path === '/api/fs/list').map(request => request.directory) }));
  return button;
}
test('absolute absent owned path remains usable with unresolved home', async () => {
  await mount('', false);
  const button = await typePath(`${owned}/`);
  assert.equal(button.disabled, false, 'unavailable home must not disable an explicit absolute owned path');
  assert.ok(requests.some(request => request.directory === `${owned}/`), 'actual directory browse must occur');
  assert.equal(useProjectsStore.getState().projects.length, 0, 'readiness is not an Add mutation');
});
for (const home of ['', '/offline/home']) {
  test(`already-member target cannot Add with ${home ? 'known' : 'unresolved'} home`, async () => {
    await mount(home, true);
    const button = await typePath(`${owned}/`);
    assert.match(button.textContent, /^Already added/);
    assert.equal(button.disabled, true);
  });
}
for (const input of ['', 'child/', '~', '~/child/']) {
  test(`unresolved home does not manufacture a target for ${JSON.stringify(input)}`, async () => {
    await mount('', false);
    assert.equal((await typePath(input)).disabled, true);
    assert.equal(requests.filter(request => request.path === '/api/fs/list').length, 0);
  });
}
for (const [home, input, browse] of [['', '/', '/'], ['', 'C:/owned/', 'C:/owned/'],
  ['/offline/home', 'child/', 'child/'], ['/offline/home', '~/child/', '/offline/home/child/']]) {
  test(`existing path semantics: ${input} with ${home ? 'known' : 'unresolved'} home`, async () => {
    await mount(home, false);
    assert.equal((await typePath(input)).disabled, false);
    assert.ok(requests.some(request => request.directory === browse));
  });
}
test('filesystem refusal still disables an absent absolute target', async () => {
  listingStatus = 403;
  await mount('', false);
  assert.equal((await typePath('/offline/denied/')).disabled, true);
  assert.ok(requests.some(request => request.directory === '/offline/denied/'));
});
test.after(async () => {
  await act(async () => root.unmount());
  await loader.close();
  await window.happyDOM.close();
  await rm(cacheDir, { recursive: true, force: true });
  assert.deepEqual(unexpected, []);
  // Keep fetch/listen sealed through isolated-process exit, including deferred persistence.
});
