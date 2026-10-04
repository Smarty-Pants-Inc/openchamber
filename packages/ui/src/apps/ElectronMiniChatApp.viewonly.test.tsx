import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { plugin } from 'bun';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const browser = new Window({ url: 'http://runtime.test/mini-chat.html?mode=session&sessionId=ses_viewonly&directory=/workspace' });
const install = <T,>(name: string, value: T) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
install('window', browser);
install('document', browser.document);
install('navigator', browser.navigator);
install('localStorage', browser.localStorage);
install('CustomEvent', browser.CustomEvent);
install('HTMLElement', browser.HTMLElement);
install('Element', browser.Element);
install('customElements', browser.customElements);
install('Document', browser.Document);
install('DocumentFragment', browser.DocumentFragment);
install('ShadowRoot', browser.ShadowRoot);
install('Node', browser.Node);
install('getComputedStyle', browser.getComputedStyle.bind(browser));
install('requestAnimationFrame', browser.requestAnimationFrame.bind(browser));
install('cancelAnimationFrame', browser.cancelAnimationFrame.bind(browser));
install('ResizeObserver', browser.ResizeObserver);
install('MutationObserver', browser.MutationObserver);
install('IS_REACT_ACT_ENVIRONMENT', true);
// Non-callable socket constants retain idle dictation cleanup semantics while
// making the real event pipeline use its fetch/SSE fallback.
install('WebSocket', { OPEN: 1, CLOSED: 3 });
install('BroadcastChannel', undefined);
const unexpected: string[] = [];
// A View only session (a fleet Pi's journal the gateway serves read-only), opened in its own Mini Chat window.
const SESSION = { id: 'ses_viewonly', slug: 'fleet', projectID: 'fixture', directory: '/workspace', title: 'fleet', version: 'fixture',
  time: { created: 1, updated: 1 } };
let watchOpens = 0;
let watchesOpen = 0;
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
const json = (value: Parameters<typeof Response.json>[0]) => Response.json(value);
const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), browser.location.origin);
  if (url.origin !== browser.location.origin) {
    unexpected.push(url.origin);
    throw new Error('External IO blocked by mini-chat fixture');
  }
  const path = url.pathname;
  if (path.endsWith('/event') && url.searchParams.get('watch') === SESSION.id) { // The View only watch.
    watchOpens += 1; watchesOpen += 1;
    const signal = input instanceof Request ? input.signal : init?.signal;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'smarty.watch', properties: { sessionID: SESSION.id, resumed: true } })}\n\n`));
      const close = () => { watchesOpen -= 1; controller.close(); };
      if (signal?.aborted) close();
      else signal?.addEventListener('abort', close, { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } });
  }
  if (path.endsWith('/global/health')) return json({ healthy: true, version: 'fixture', capabilities: { readOnlyWatch: 1, readOnlyReadBaseline: 1, readOnlyWatchResume: 1 } });
  if (path.endsWith(`/session/${SESSION.id}/message`)) return Response.json([], { headers: { 'x-smarty-read-only': '1' } });
  if (path === `/api/session/${SESSION.id}`) return json(SESSION);
  if (path === '/api/session') return json([SESSION]);
  if (path.endsWith('/global/event')) {
    const signal = input instanceof Request ? input.signal : init?.signal;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      streams.add(controller);
      const close = () => { if (streams.delete(controller)) controller.close(); };
      if (signal?.aborted) close();
      else signal?.addEventListener('abort', close, { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } });
  }
  if (path === '/auth/session') return json({ authenticated: true });
  if (path === '/auth/url-token') return json({ token: 'fixture-url-token', expiresAt: Date.now() + 60_000 });
  if (path.endsWith('/passkey/status')) return json({ enabled: false, hasPasskeys: false, passkeyCount: 0, rpID: null });
  if (path.endsWith('/health')) return json({ healthy: true, version: 'fixture' });
  if (path.endsWith('/path')) return json({ home: '/workspace', directory: '/workspace', worktree: '/workspace', state: '', config: '' });
  if (path.endsWith('/project/current')) return json({ id: 'fixture', worktree: '/workspace' });
  if (path.endsWith('/config/providers')) return json({ providers: [], default: {} });
  if (path.endsWith('/session/status') || path.endsWith('/settings') || path.endsWith('/config')) return json({});
  if (path.endsWith('/fs/home')) return json({ home: '/workspace' });
  if (path.endsWith('/fs/list')) return json({ entries: [] });
  return json([]);
};
// Keep transport fences installed through exit, including late teardown work.
install('fetch', fakeFetch);
Object.defineProperty(browser, 'fetch', { configurable: true, value: fakeFetch });
// Bun does not implement Vite's worker-URL asset transform. This empty-draft
// scenario never starts the markdown worker; fail if it attempts to do so.
await plugin({ name: 'mini-chat-worker-url', setup(build) {
  build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, () => ({
    contents: "export default 'data:text/javascript,throw new Error(\"Unexpected markdown worker\")'",
    loader: 'js',
  }));
  build.onLoad({ filter: /useProviderLogo\.ts$/ }, async ({ path }): Promise<{ contents: string; loader: 'ts' }> => {
    const logos = Object.fromEntries(readdirSync(fileURLToPath(new URL('../assets/provider-logos/', import.meta.url))).filter((name) => name.endsWith('.svg'))
      .map((name) => [`../assets/provider-logos/${name}`, `/assets/provider-logos/${name}`]));
    const source = await readFile(path, 'utf8');
    return { contents: source.replace(/import\.meta\.glob<string>\([\s\S]*?\);/, `${JSON.stringify(logos)};`), loader: 'ts' };
  });
} });
const { ElectronMiniChatApp } = await import('./ElectronMiniChatApp');
const { SessionAuthGate } = await import('@/components/auth/SessionAuthGate');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { ThemeProvider } = await import('@/components/providers/ThemeProvider');
const { createWebAPIs } = await import('../../../web/src/api');
const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { holdViewOnlyWatch, viewOnlyWatchesHeld } = await import('@/sync/view-only-watch');

afterAll(async () => { await browser.happyDOM.abort(); });

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  return ok();
};

// openchamber#278 review 12: a View only transcript on screen in the Mini Chat window keeps tailing, whatever the main
// window shows: the production Mini Chat renderer holds its own watch.
test("the Mini Chat window holds its View only session's watch while it shows it; a main view's release keeps it", async () => {
  useDirectoryStore.setState({ currentDirectory: '/workspace' });
  const apis = createWebAPIs();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(<I18nProvider><ThemeSystemProvider><ThemeProvider><SessionAuthGate><ElectronMiniChatApp apis={apis} /></SessionAuthGate></ThemeProvider></ThemeSystemProvider></I18nProvider>);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(await until(() => useSessionUIStore.getState().currentSessionId === SESSION.id)).toBe(true); // Mini Chat shows it,
    expect(await until(() => watchesOpen === 1)).toBe(true); // and holds its watch on the gateway.
    expect(viewOnlyWatchesHeld()).toBe(1);
    // The main view shows the same session, then switches away: its release leaves the Mini Chat's watch held.
    const mainView = holdViewOnlyWatch(SESSION.id, '/workspace');
    mainView();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(viewOnlyWatchesHeld()).toBe(1);
    expect(watchesOpen).toBe(1);
    expect(watchOpens).toBe(1); // The same stream throughout.
    await act(async () => root.unmount()); // The Mini Chat window closes: nothing held.
    expect(await until(() => watchesOpen === 0)).toBe(true);
    expect(viewOnlyWatchesHeld()).toBe(0);
    expect(unexpected).toEqual([]);
  } finally {
    host.remove();
  }
});
