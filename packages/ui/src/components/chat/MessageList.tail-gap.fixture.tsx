import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createOpencodeClient, type Event, type Message, type Part } from '@opencode-ai/sdk/v2/client';
import type { LegendListRef } from '@legendapp/list/react';
// Only the existing geometry/frame and unrelated presentation/environment adapters are reused.
import { container, stepFrame } from './MessageList.continuity.fixture';
const { default: MessageList } = await import('./MessageList');
import { I18nProvider } from '@/lib/i18n';
import { ChildStoreManager } from '@/sync/child-store';
import { SessionMessageLoader, setImperativeSessionMessageLoader } from '@/sync/session-message-loader';
import { createEventRoutingIndex, handleEvent, useSessionMessageRecords, useSessionMessageLoadState,
  type useSyncRuntime } from '@/sync/sync-context';
import { getRuntimeKey } from '@/lib/runtime-switch';

export const glyph = 'full displayable tail-gap fixture glyphs';
const target = { directory: '/tail-gap-fixture', sessionID: 'tail-gap-session' };
export type FullRecord = { info: Message; parts: Part[] };
export const record = (id: string, created = 1, echoOf?: string): FullRecord => {
  const info: Extract<Message, { role: 'user' }> & { metadata?: { smartyCodeEchoOf: string } } = {
    id, sessionID: target.sessionID, role: 'user', time: { created }, agent: 'build',
    model: { providerID: 'test', modelID: 'test' }, metadata: echoOf ? { smartyCodeEchoOf: echoOf } : undefined,
  };
  return { info, parts: [{ id: `part-${id}`, messageID: id, sessionID: target.sessionID, type: 'text', text: glyph }] };
};
type Runtime = ReturnType<typeof useSyncRuntime>;
// SAFETY: sync-context publishes these exact typed global context registry keys for its public hooks.
const registry = globalThis as typeof globalThis & {
  __openchamber_sync_runtime_context__: React.Context<Runtime | null>;
  __openchamber_sync_context__: React.Context<(Runtime & { directory: string }) | null>;
};
const RuntimeContext = registry.__openchamber_sync_runtime_context__;
const SystemContext = registry.__openchamber_sync_context__;
const summarize = (items: FullRecord[], text: string) => items.map(({ info, parts }) => ({ id: info.id,
  parts: parts.map((part) => ({ id: part.id, type: part.type, displayable: part.type === 'text' && part.text === text })) }));

export async function mount(initial = [record('A')], at = 0, total = at + initial.length, observedGlyph = glyph) {
  const summary = (items: FullRecord[]) => summarize(items, observedGlyph);
  const children = new ChildStoreManager();
  let page = initial, epoch = 'P', history = 'H', start = at, count = total, held = false;
  const releases: Array<() => void> = [], requests: Array<{ method: string; path: string; query: string; epoch: string; history: string; at: number; total: number; records: ReturnType<typeof summary> }> = [];
  const sdk = createOpencodeClient({ baseUrl: 'http://tail-gap.invalid', fetch: async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    const response = Response.json(page, { headers: { 'x-smarty-at': String(start), 'x-smarty-total': String(count),
      'x-smarty-index-epoch': epoch, 'x-smarty-history-epoch': history,
      'x-smarty-ordinary-view': `ov2_${'a'.repeat(64)}` } });
    if (page.some((item) => !item.parts.some((part) => part.type === 'text' && part.text === observedGlyph))) throw new Error('NOT RED: HTTP record lacks full glyph parts');
    requests.push({ method: request.method, path: url.pathname, query: url.search, epoch, history, at: start, total: count, records: summary(page) });
    if (held) await new Promise<void>((resolve) => releases.push(resolve));
    return response;
  } });
  const runtimeKey = getRuntimeKey();
  const loader = new SessionMessageLoader(children, { sdk, runtimeKey });
  const store = children.ensureChild(target.directory, { bootstrap: false });
  store.setState({ status: 'complete' }); // Environment prerequisite, never message/part injection.
  const host = document.createElement('div'); container.appendChild(host);
  const root = createRoot(host), routing = createEventRoutingIndex();
  let committed: FullRecord[] = [], registered: LegendListRef | null = null, nextIdentity = 0;
  const identities = new WeakMap<LegendListRef | Element, number>();
  const identity = (value: LegendListRef | Element | null) => {
    if (!value) return null;
    let id = identities.get(value);
    if (id === undefined) { id = ++nextIdentity; identities.set(value, id); }
    return id;
  };
  const registerList = (value: LegendListRef | null) => { registered = value; };
  const release = () => { held = false; for (const resolve of releases.splice(0)) resolve(); };
  const close = async () => {
    await act(async () => root.unmount()); host.remove(); loader.dispose(); children.disposeAll();
    setImperativeSessionMessageLoader(null); release();
    await stepFrame();
    console.log('CLEANUP tail-gap own root/loader/stores/held responses released; frame callbacks drained');
  };
  const runtime: Runtime = { childStores: children, sdk, messageLoader: loader, runtimeKey,
    currentDirectory: { get: () => target.directory, subscribe: () => () => undefined } };
  function ConnectedList() {
    const messages = useSessionMessageRecords(target.sessionID, target.directory);
    const load = useSessionMessageLoadState(target.sessionID, target.directory);
    const positionOf = React.useCallback((id: string) => { void load.positions; return loader.positionOf(target, id); }, [load.positions]);
    React.useLayoutEffect(() => { committed = messages; }, [messages]);
    return <MessageList sessionKey={target.sessionID} messages={messages} isLoadingOlder={false}
      positions={load.positions} positionOf={positionOf} registerList={registerList}
      scrollContainerProps={{ 'data-scrollbar': 'chat', style: { height: 800, width: 1000 } }} />;
  }
  try {
    setImperativeSessionMessageLoader(loader);
    await loader.ensure(target, { reason: 'navigation' });
    await act(async () => root.render(<RuntimeContext.Provider value={runtime}>
      <SystemContext.Provider value={{ ...runtime, directory: target.directory }}><I18nProvider><ConnectedList /></I18nProvider></SystemContext.Provider>
    </RuntimeContext.Provider>));
  } catch (error) { await close(); throw error; }
  const observe = () => {
    const state = store.getState();
    return { list: identity(registered), scroller: identity(host.querySelector('[data-scrollbar="chat"]')),
      gaps: host.querySelectorAll('[data-history-gap]').length, status: loader.getSnapshot(target).status,
      positions: loader.getSnapshot(target).positions, hooks: summary(committed),
      store: summary((state.message[target.sessionID] ?? []).map((info) => ({ info, parts: state.part[info.id] ?? [] }))),
      rows: committed.map(({ info }) => {
        const rows = [...host.querySelectorAll<HTMLElement>(`[data-message-id="${info.id}"]`)];
        const hidden: string[] = [];
        for (const row of rows) {
          const walker = document.createTreeWalker(row, 4);
          let text = walker.nextNode();
          while (text && !text.textContent?.includes(observedGlyph)) text = walker.nextNode();
          for (let node = text?.parentElement; node; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (style.opacity === '0' || node.classList.contains('opacity-0') || style.display === 'none' || style.visibility === 'hidden') hidden.push(`${node.tagName}:${node.getAttribute('style')}:${node.className}`);
            if (node === host) break;
          }
        }
        return { id: info.id, position: loader.positionOf(target, info.id), glyphs: rows.filter((row) => row.textContent?.includes(observedGlyph)).length, hidden };
      }), requests: [...requests] };
  };
  const emit = (event: Event) => handleEvent(target.directory, event, children, routing, runtimeKey);
  const stream = (item: FullRecord) => act(async () => {
    emit({ id: `info-${item.info.id}`, type: 'message.updated', properties: { sessionID: target.sessionID, info: item.info } });
    for (const part of item.parts) emit({ id: `part-${part.id}`, type: 'message.part.updated', properties: { part, sessionID: target.sessionID, time: Date.now() } });
  });
  const index = (nextEpoch: string, nextTotal: number, nextHistory = 'H') => act(async () => {
    const event = { id: `index-${nextEpoch}`, type: 'session.index', properties: { sessionID: target.sessionID, total: nextTotal, epoch: nextEpoch, historyEpoch: nextHistory } };
    // SAFETY: the gateway extends the SDK event union; handleEvent validates these index fields in production.
    emit(event as Event);
  });
  const configure = (items: FullRecord[], nextEpoch = 'Q', nextHistory = 'H', nextAt = 0, nextTotal = nextAt + items.length) => {
    page = items; epoch = nextEpoch; history = nextHistory; start = nextAt; count = nextTotal;
  };
  const frame = async (label: string) => { await stepFrame(); const value = observe(); console.log(label, JSON.stringify(value)); return value; };
  const settle = async (id: string) => {
    for (let i = 0; i < 30; i++) {
      await stepFrame(); const row = observe().rows.find((item) => item.id === id);
      if (row?.glyphs === 1 && row.hidden.length === 0) return;
    }
    throw new Error(`NOT RED: real glyph never settled ${id}: ${JSON.stringify(observe())}`);
  };
  return { observe, frame, settle, stream, index, configure, close,
    info: (item: FullRecord) => act(async () => emit({ id: `info-${item.info.id}`, type: 'message.updated', properties: { sessionID: target.sessionID, info: item.info } })),
    part: (part: Part) => act(async () => emit({ id: `part-${part.id}`, type: 'message.part.updated', properties: { part, sessionID: target.sessionID, time: Date.now() } })),
    hold: () => { held = true; },
    remove: (id: string) => act(async () => emit({ id: `remove-${id}`, type: 'message.removed', properties: { sessionID: target.sessionID, messageID: id } })),
    release: () => act(async () => { release(); await loader.refreshTail(target, 50); }),
    refresh: () => act(async () => { await loader.refreshTail(target, 50); }) };
}
