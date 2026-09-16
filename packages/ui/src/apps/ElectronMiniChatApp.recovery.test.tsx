import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { fileURLToPath } from 'node:url';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const browser = new Window({ url: 'http://runtime.test/mini-chat.html?mode=draft&directory=/workspace&projectId=fixture' });
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
let streamOpens = 0;
let aborts = 0;
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
const json = (value: Parameters<typeof Response.json>[0]) => Response.json(value);
const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), browser.location.origin);
  if (url.origin !== browser.location.origin) {
    unexpected.push(url.origin);
    throw new Error('External IO blocked by mini-chat fixture');
  }
  const path = url.pathname;
  if (path.endsWith('/global/event')) {
    streamOpens += 1;
    const signal = input instanceof Request ? input.signal : init?.signal;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      streams.add(controller);
      const close = () => { if (streams.delete(controller)) controller.close(); };
      if (signal?.aborted) close();
      else signal?.addEventListener('abort', close, { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } });
  }
  if (path.endsWith('/abort')) { aborts += 1; return json(true); }
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
await Bun.plugin({ name: 'mini-chat-worker-url', setup(build) {
  build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, () => ({
    contents: "export default 'data:text/javascript,throw new Error(\"Unexpected markdown worker\")'",
    loader: 'js',
  }));
  build.onLoad({ filter: /useProviderLogo\.ts$/ }, async ({ path }) => {
    const logos = Object.fromEntries(Array.from(new Bun.Glob('*.svg').scanSync(fileURLToPath(new URL('../assets/provider-logos/', import.meta.url))))
      .map((name) => [`../assets/provider-logos/${name}`, `/assets/provider-logos/${name}`]));
    const source = await Bun.file(path).text();
    return { contents: source.replace(/import\.meta\.glob<string>\([\s\S]*?\);/, `${JSON.stringify(logos)};`), loader: 'ts' };
  });
} });
const { EditorView } = await import('@codemirror/view');
const { ElectronMiniChatApp } = await import('./ElectronMiniChatApp');
const { SessionAuthGate } = await import('@/components/auth/SessionAuthGate');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { ThemeProvider } = await import('@/components/providers/ThemeProvider');
const { createWebAPIs } = await import('../../../web/src/api');
const { useAuthSessionStore } = await import('@/lib/runtime-auth-expiry');
const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { getSyncChildStores } = await import('@/sync/sync-refs');
const { getImperativeSessionMessageLoader } = await import('@/sync/session-message-loader');
const { abortCurrentOperation } = await import('@/sync/session-actions');
const { opencodeClient } = await import('@/lib/opencode/client');
const { getRuntimeKey, getRuntimeApiBaseUrl } = await import('@/lib/runtime-switch');

afterAll(async () => { await browser.happyDOM.abort(); });

test('gated production mini-chat rebinds after verified recovery without replacing its workspace', async () => {
  useDirectoryStore.setState({ currentDirectory: '/workspace' });
  const apis = createWebAPIs();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let ownerRenders = 0;
  const Owner = React.memo(() => {
    ownerRenders += 1;
    return <ElectronMiniChatApp apis={apis} />;
  });
  const child = <Owner />;
  try {
    await act(async () => {
      root.render(<I18nProvider><ThemeSystemProvider><ThemeProvider><SessionAuthGate>{child}</SessionAuthGate></ThemeProvider></ThemeSystemProvider></I18nProvider>);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const loader = getImperativeSessionMessageLoader();
    if (!loader) throw new Error('Production mini-chat did not mount its loader');
    const children = getSyncChildStores();
    const sdk = opencodeClient.getSdkClient();
    const editor = host.querySelector<HTMLElement>('.cm-editor');
    if (!editor) throw new Error('Production mini-chat composer did not mount');
    const composer = EditorView.findFromDOM(editor);
    if (!composer) throw new Error('Composer has no CodeMirror owner');
    await act(async () => { composer.dispatch({ changes: { from: 0, insert: 'unsent fixture text' } }); });
    const draft = useSessionUIStore.getState().newSessionDraft;
    const runtimeKey = getRuntimeKey();
    const baseUrl = getRuntimeApiBaseUrl();
    const opened = streamOpens;
    expect(draft.open).toBe(true);
    expect(ownerRenders).toBe(1);
    await act(async () => { useAuthSessionStore.getState().markExpired(); });
    const login = host.querySelector<HTMLButtonElement>('[role="alert"] button');
    expect(login).not.toBeNull();
    await act(async () => { login?.click(); });
    expect(useAuthSessionStore.getState().state).toBe('ok');
    expect(streamOpens).toBe(opened + 1);
    expect(streams.size).toBe(1);
    expect(getImperativeSessionMessageLoader()).toBe(loader);
    expect(getSyncChildStores()).toBe(children);
    expect(useSessionUIStore.getState().newSessionDraft).toBe(draft);
    expect(host.querySelector('.cm-editor')).toBe(editor);
    expect(EditorView.findFromDOM(editor)).toBe(composer);
    expect(composer.state.doc.toString()).toBe('unsent fixture text');
    expect(ownerRenders).toBe(1);
    expect(useDirectoryStore.getState().currentDirectory).toBe('/workspace');
    expect(getRuntimeKey()).toBe(runtimeKey);
    expect(getRuntimeApiBaseUrl()).toBe(baseUrl);
    await expect(sdk.session.list({}, { throwOnError: true })).rejects.toThrow('Runtime request is stale');
    await act(async () => { await loader.ensure({ directory: '/workspace', sessionID: 'session-fixture' }); });
    expect(loader.getSnapshot({ directory: '/workspace', sessionID: 'session-fixture' }).status).toBe('ready');
    await act(async () => { await abortCurrentOperation('session-fixture'); });
    expect(aborts).toBe(1);
    expect(unexpected).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
