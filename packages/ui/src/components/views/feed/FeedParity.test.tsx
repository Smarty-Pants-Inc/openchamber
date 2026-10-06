import { afterAll, expect, test } from 'bun:test';
import { plugin } from 'bun';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';
import type { Message, Part } from '@opencode-ai/sdk/v2';

// smarty-code#1407: the Feed renders an entry with the chat's own message component, so an assistant's final answer
// looks exactly as it does in the chat (Markdown, code blocks with copy, links, tables, images). The same final-text
// part and image part go through the Feed and through ChatMessage, and must come out as the same HTML.

// Bun does not implement Vite's worker-URL and import.meta.glob transforms (as ElectronMiniChatApp.recovery.test.tsx).
await plugin({ name: 'feed-parity-vite-transforms', setup(build) {
  build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, () => ({ contents: "export default 'data:text/javascript,'", loader: 'js' }));
  build.onLoad({ filter: /useProviderLogo\.ts$/ }, async ({ path }) => {
    const logos = Object.fromEntries(readdirSync(fileURLToPath(new URL('../../../assets/provider-logos/', import.meta.url)))
      .filter((name) => name.endsWith('.svg')).map((name) => [`../assets/provider-logos/${name}`, `/assets/provider-logos/${name}`]));
    const source = await readFile(path, 'utf8');
    return { contents: source.replace(/import\.meta\.glob<string>\([\s\S]*?\);/, `${JSON.stringify(logos)};`), loader: 'ts' };
  });
} });

const win = new Window({ url: 'http://localhost' });
win.document.write('<!doctype html><html><body></body></html>');
const values = { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
  HTMLElement: win.HTMLElement, Element: win.Element, Node: win.Node, HTMLAnchorElement: win.HTMLAnchorElement, HTMLImageElement: win.HTMLImageElement,
  SVGElement: win.SVGElement, Text: win.Text, DocumentFragment: win.DocumentFragment, DOMParser: win.DOMParser, MutationObserver: win.MutationObserver,
  ResizeObserver: win.ResizeObserver, IntersectionObserver: win.IntersectionObserver, CustomEvent: win.CustomEvent, NodeFilter: win.NodeFilter,
  customElements: win.customElements, getComputedStyle: win.getComputedStyle.bind(win), matchMedia: win.matchMedia.bind(win),
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0), cancelAnimationFrame: (id: number) => clearTimeout(id),
  // No server: the stores a chat row reads may ask for their data; every request fails, as an offline page would.
  fetch: async () => new Response('{}', { status: 404 }) };
const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });

const { loadMarkdownRendererModule } = await import('@/components/chat/markdownRendererLoader');
const { default: ChatMessage } = await import('@/components/chat/ChatMessage');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { RuntimeAPIProvider } = await import('@/contexts/RuntimeAPIProvider');
const { createWebAPIs } = await import('../../../../../web/src/api');
const { ChildStoreManager } = await import('@/sync/child-store');
const { SessionMessageLoader } = await import('@/sync/session-message-loader');
const { getRuntimeKey } = await import('@/lib/runtime-switch');
const { feedEntries } = await import('./feedEntries');
const { FeedTranscript } = await import('./FeedTranscript');
const { scrollToFeedEntry } = await import('./feedScroll');
await loadMarkdownRendererModule();

const DIRECTORY = '/repo';
const children = new ChildStoreManager();
children.ensureChild(DIRECTORY, { bootstrap: false });
// SAFETY: nothing here loads history (the rows are given), so the loader never calls the SDK.
const loader = new SessionMessageLoader(children, { sdk: {} as never, runtimeKey: getRuntimeKey() });
const system = { childStores: children, messageLoader: loader, sdk: {}, runtimeKey: getRuntimeKey(), directory: DIRECTORY };
const runtime = { ...system, currentDirectory: { get: () => DIRECTORY, subscribe: () => () => undefined } };
// sync-context publishes its two React contexts on globalThis (UnsavedLabel.dom.test.tsx provides them the same way).
const Sync: React.Context<unknown> = Object.getOwnPropertyDescriptor(globalThis, '__openchamber_sync_context__')?.value;
const SyncRuntime: React.Context<unknown> = Object.getOwnPropertyDescriptor(globalThis, '__openchamber_sync_runtime_context__')?.value;
const apis = createWebAPIs();

afterAll(async () => {
  loader.dispose();
  children.disposeAll();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
  await win.happyDOM.close();
});

const user = (id: string, created: number, parts: Part[]) => ({
  info: { id, sessionID: 's', role: 'user', time: { created }, agent: 'build', model: { providerID: 'p', modelID: 'm' } } satisfies Message,
  parts,
});
const assistant = (id: string, created: number, parts: Part[]) => ({
  info: { id, sessionID: 's', role: 'assistant', time: { created, completed: created + 1 }, parentID: 'u1', modelID: 'm', providerID: 'p', mode: 'build',
    agent: 'build', finish: 'stop', path: { cwd: DIRECTORY, root: DIRECTORY }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } satisfies Message,
  parts,
});
const answer = [
  '## Your reviews', '', 'Two PRs wait for you; see [the queue](https://github.com/smarty/pulls).', '',
  '```ts', 'const waiting = 2;', '```', '', '| PR | Age |', '|---|---|', '| #12 | 2 days |',
].join('\n');
const image = (id: string, messageID: string): Part => ({ id, sessionID: 's', messageID, type: 'file', mime: 'image/png', filename: 'chart.png', url: 'data:image/png;base64,iVBORw0KGgo=' });
const records = [
  user('u1', 100, [{ id: 'u1t', sessionID: 's', messageID: 'u1', type: 'text', text: 'What is waiting for me?' }, image('u1f', 'u1')]),
  assistant('a1', 110, [{ id: 'a1r', sessionID: 's', messageID: 'a1', type: 'reasoning', text: 'Thinking about the queue', time: { start: 1, end: 2 } },
    { id: 'a1t', sessionID: 's', messageID: 'a1', type: 'text', text: 'Let me check the PRs.', time: { start: 1, end: 2 } },
    { id: 'a1x', sessionID: 's', messageID: 'a1', type: 'tool', callID: 'a1x', tool: 'bash',
      state: { status: 'completed', input: {}, output: 'gh pr list', title: 'gh pr list', metadata: {}, time: { start: 1, end: 2 } } }]),
  assistant('a2', 120, [{ id: 'a2t', sessionID: 's', messageID: 'a2', type: 'text', text: answer, time: { start: 3, end: 4 } }, image('a2f', 'a2')]),
];

const render = async (node: React.ReactNode) => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(
    <I18nProvider><ThemeSystemProvider><RuntimeAPIProvider apis={apis}>
      <Sync.Provider value={system}><SyncRuntime.Provider value={runtime}>{node}</SyncRuntime.Provider></Sync.Provider>
    </RuntimeAPIProvider></ThemeSystemProvider></I18nProvider>));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
  return { host, unmount: () => act(async () => root.unmount()) };
};
// Each rendered Markdown block gets a page-unique decoration id; everything else must match.
const html = (element: Element | null | undefined) => element?.outerHTML.replace(/ data-md-decoration-id="[^"]*"/g, '') ?? null;
const textPart = (host: Element, messageId: string) => html(host.querySelector(`[data-message-id="${messageId}"] [data-message-text-export-source="true"]`));
const imagePart = (host: Element, messageId: string) => html(host.querySelector(`[data-message-id="${messageId}"] img[alt="chart.png"]`));

test('an assistant final answer renders the same through the Feed and through the chat message component', async () => {
  const chat = await render(<ChatMessage message={records[2]} />);
  const feed = await render(<FeedTranscript entries={feedEntries(records)} name="Smarty" working={false} loading={false} failed={false} onRetry={() => undefined} />);

  const chatText = textPart(chat.host, 'a2');
  expect(chatText).toContain('<table');
  expect(chatText).toContain('href="https://github.com/smarty/pulls"');
  expect(chatText).toContain('data-md-action="copy-code"');
  expect(textPart(feed.host, 'a2')).toBe(chatText);
  expect(imagePart(chat.host, 'a2')).not.toBeNull();
  expect(imagePart(feed.host, 'a2')).toBe(imagePart(chat.host, 'a2'));
  // Only the final answer: no reasoning, tool row, or text written between tool calls.
  expect(feed.host.textContent).not.toContain('Let me check the PRs.');
  expect(feed.host.textContent).not.toContain('Thinking about the queue');
  expect(feed.host.textContent).not.toContain('gh pr list');
  await chat.unmount();
  await feed.unmount();
});

test('a user message keeps its attachments, as the chat shows them', async () => {
  const chat = await render(<ChatMessage message={records[0]} />);
  const feed = await render(<FeedTranscript entries={feedEntries(records)} name="Smarty" working={false} loading={false} failed={false} onRetry={() => undefined} />);
  expect(imagePart(chat.host, 'u1')).not.toBeNull();
  expect(imagePart(feed.host, 'u1')).toBe(imagePart(chat.host, 'u1'));
  await chat.unmount();
  await feed.unmount();
});

test('the Timeline jump scrolls the Feed to the chosen message, and reports a message the Feed does not show', async () => {
  const scroller = React.createRef<HTMLDivElement>();
  const feed = await render(<FeedTranscript entries={feedEntries(records)} name="Smarty" working={false} loading={false} failed={false} onRetry={() => undefined} scrollerRef={scroller} />);
  const target = feed.host.querySelector<HTMLElement>('[data-feed-message-id="u1"]');
  if (!target) throw new Error('no entry for u1');
  let scrolledTo: Element | null = null;
  target.scrollIntoView = () => { scrolledTo = target; };
  expect(scrollToFeedEntry(scroller.current, 'u1')).toBe(true);
  expect(scrolledTo).toBe(target);
  expect(scrollToFeedEntry(scroller.current, 'a1')).toBe(false); // a1's answer is not in the Feed (it led into a tool call)
  await feed.unmount();
});
