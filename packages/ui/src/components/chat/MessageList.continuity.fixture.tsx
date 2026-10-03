import { afterAll, afterEach, beforeEach, expect, mock } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { LegendListRef } from '@legendapp/list/react';
import type { ChatMessageEntry } from './lib/turns/types';
import type { SessionPositions } from '@/sync/session-message-loader';

// Existing baseline seams: only unrelated theme/runtime presentation is replaced.
// MessageList, ChatMessage, row builders, FadeInOnReveal and LegendList remain real.
mock.module('@/contexts/useThemeSystem', () => ({
  useThemeSystem: () => ({ currentTheme: { metadata: { id: 'test', variant: 'light' } } }),
  useOptionalThemeSystem: () => null,
}));
mock.module('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ vscode: undefined }) }));
mock.module('@/hooks/useProviderLogo', () => ({ useProviderLogo: () => ({ src: null, hasLogo: false, onError() {} }) }));
// Vite's worker URL import is not executed for plain user text in this fixture.
mock.module('./markdown/markdown-shiki.worker.ts?worker&url', () => ({ default: 'unused-worker-url' }));
const { default: MessageList } = await import('./MessageList');
const { I18nProvider } = await import('@/lib/i18n');
const { useUIStore } = await import('@/stores/useUIStore');
export const { withoutSupersededOptimistic } = await import('@/sync/superseded-optimistic');
export const { optimisticMessageRecords } = await import('@/sync/unsaved');
export const { markPendingUserSendAnimation } = await import('@/lib/userSendAnimation');
const { ChildStoreManager } = await import('@/sync/child-store');
const { SessionMessageLoader } = await import('@/sync/session-message-loader');
const { createOpencodeClient } = await import('@opencode-ai/sdk/v2/client');
const { getRuntimeKey } = await import('@/lib/runtime-switch');
type Runtime = ReturnType<typeof import('@/sync/sync-context').useSyncRuntime>;
// SAFETY: these exact typed context registry keys are published by the real sync-context module imported above.
const registry = globalThis as typeof globalThis & {
  __openchamber_sync_runtime_context__: React.Context<Runtime | null>;
  __openchamber_sync_context__: React.Context<(Runtime & { directory: string }) | null>;
};
const RuntimeContext = registry.__openchamber_sync_runtime_context__;
const SystemContext = registry.__openchamber_sync_context__;
const children = new ChildStoreManager();
const sdk = createOpencodeClient({ baseUrl: 'http://unused.invalid' });
const loader = new SessionMessageLoader(children, { sdk, runtimeKey: getRuntimeKey() });
// Empty directory selects the real read-only unselected store: no bootstrap or HTTP.
const runtime: Runtime = { childStores: children, sdk, messageLoader: loader, runtimeKey: getRuntimeKey(),
  currentDirectory: { get: () => '', subscribe: () => () => undefined } };
let win: Window;
export let container: HTMLElement;
let root: Root;
let previous: Map<string, PropertyDescriptor | undefined>;
let frames: Map<number, FrameRequestCallback>;
let nextFrame = 0;
let registered: LegendListRef | null = null;
let measuredTop = 0;
let measuredHeight = 80;
export const sessionKey = 'continuity-session';
export const list = () => { if (!registered) throw new Error('Real list is not registered'); return registered; };
export const measureRowTop = (top: number) => { measuredTop = top; };
export const measureRowHeight = (height: number) => { measuredHeight = height; };
const registerList = (value: LegendListRef | null) => { registered = value; };
export const entry = (id: string, echoOf?: string): ChatMessageEntry => {
  const info: Extract<ChatMessageEntry['info'], { role: 'user' }> & { metadata?: { smartyCodeEchoOf: string } } = {
    id, sessionID: sessionKey, role: 'user', time: { created: 1 },
    agent: 'build', model: { providerID: 'test', modelID: 'test' },
    metadata: echoOf ? { smartyCodeEchoOf: echoOf } : undefined,
  };
  return { info, parts: [{ id: `part-${id}`, sessionID: sessionKey, messageID: id, type: 'text', text: 'visible continuity glyphs' }] };
};
export const positions = (epoch: string, historyEpoch?: string): SessionPositions => ({ total: 1, ranges: [{ start: 0, end: 1 }], epoch, historyEpoch });
export const render = (messages: ChatMessageEntry[], index?: SessionPositions,
  positionOf: (id: string) => number | undefined = () => 0) => act(async () => {
  root.render(<RuntimeContext.Provider value={runtime}><SystemContext.Provider value={{ ...runtime, directory: '' }}><I18nProvider><MessageList sessionKey={sessionKey} messages={messages} isLoadingOlder={false}
    positions={index} positionOf={index ? positionOf : undefined} registerList={registerList}
    scrollContainerProps={{ 'data-scrollbar': 'chat', style: { height: 800, width: 1000 } }} /></I18nProvider></SystemContext.Provider></RuntimeContext.Provider>);
});
// Walk the actual glyph's ancestors, including its Fade and LegendList containers.
export const visibility = (id: string) => {
  const row = container.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
  expect(row).not.toBeNull();
  expect(row?.textContent).toContain('visible continuity glyphs');
  if (!row) throw new Error(`Missing expected row ${id}`);
  const walker = document.createTreeWalker(row, win.NodeFilter.SHOW_TEXT);
  let glyph = walker.nextNode();
  while (glyph && !glyph.textContent?.includes('visible continuity glyphs')) glyph = walker.nextNode();
  expect(glyph).not.toBeNull();
  const hidden: string[] = [];
  for (let node = glyph?.parentElement; node; node = node.parentElement) {
    if (node.style.opacity === '0' || node.classList.contains('opacity-0')) hidden.push(`${node.tagName}.${node.className} style=${node.getAttribute('style')}`);
    if (node === container) break;
  }
  return hidden;
};
export const stepFrame = () => act(async () => {
  const callbacks = [...frames.values()]; frames.clear();
  for (const callback of callbacks) callback(performance.now());
  await new Promise((resolve) => setTimeout(resolve, 10));
});
export const settleVisible = async (id: string) => {
  for (let i = 0; i < 30; i++) {
    await stepFrame();
    if (container.querySelector(`[data-message-id="${id}"]`) && visibility(id).length === 0) return;
  }
  expect(visibility(id)).toEqual([]);
};
beforeEach(() => {
  win = new Window({ width: 1200, height: 800 }); frames = new Map(); measuredTop = 0; measuredHeight = 80;
  // Supply geometry to the actual measurement path, never the library's readyToRender state.
  win.HTMLElement.prototype.getBoundingClientRect = function () {
    const row = this.hasAttribute('data-turn-id') || this.hasAttribute('data-message-id');
    const height = this.hasAttribute('data-history-gap') ? Number.parseFloat(this.style.height) : measuredHeight;
    return new win.DOMRect(0, row ? measuredTop : 0, 1000, this.getAttribute('data-scrollbar') === 'chat' ? 800 : height);
  };
  Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { configurable: true,
    get() { return this.getAttribute('data-scrollbar') === 'chat' ? 800 : 80; } });
  const requestFrame: typeof window.requestAnimationFrame = (callback) => {
    const id = ++nextFrame; frames.set(id, callback); return id;
  };
  const cancelFrame: typeof window.cancelAnimationFrame = (id) => { frames.delete(id); };
  Object.defineProperties(win, { requestAnimationFrame: { value: requestFrame }, cancelAnimationFrame: { value: cancelFrame } });
  const values = { window: win, document: win.document, navigator: win.navigator,
    HTMLElement: win.HTMLElement, Element: win.Element, ResizeObserver: win.ResizeObserver,
    MutationObserver: win.MutationObserver, getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame, IS_REACT_ACT_ENVIRONMENT: true };
  previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  useUIStore.setState({ userMessageRenderingMode: 'plain', chatRenderMode: 'live', stickyUserHeader: false });
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
  await win.happyDOM.close();
});
afterAll(() => { loader.dispose(); children.disposeAll(); mock.restore(); });
