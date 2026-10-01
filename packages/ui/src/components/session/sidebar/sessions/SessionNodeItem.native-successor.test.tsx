import { afterEach, beforeEach, expect, test } from 'bun:test';
import { plugin } from 'bun';
import { readFile, readdir } from 'node:fs/promises';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { createOpencodeClient, type Session } from '@opencode-ai/sdk/v2';
import type { Event } from '@opencode-ai/sdk/v2/client';
import { I18nProvider } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { ChildStoreManager } from '@/sync/child-store';
import { SessionMessageLoader } from '@/sync/session-message-loader';
import { useSyncRuntime } from '@/sync/sync-context';
import type { SessionStatus } from '@/sync/session-status';
import { applyGlobalSessionStatusEvent, applyGlobalSessionStatusSnapshot, replaceGlobalSessionStatusById,
  useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { useSessionActivityTimingStore } from '@/sync/session-activity-timing';
import { useSessionOrderingStore } from '@/sync/session-ordering';
import type { SessionNodeItemProps } from './SessionNodeItem';

// Adapt only Vite's static SVG glob so the actual row imports in the normal isolated Bun runner.
plugin({ name: 'row-static-provider-svg', setup(build) {
  build.onLoad({ filter: /\/useProviderLogo\.ts$/ }, async ({ path }) => {
    const source = await readFile(path, 'utf8');
    const anchor = /import\.meta\.glob<string>\('\.\.\/assets\/provider-logos\/\*\.svg',\s*\{\s*eager: true,\s*import: 'default',\s*\}\)/;
    if (!anchor.test(source)) throw new Error('Static provider asset glob changed');
    const assets = path.slice(0, path.lastIndexOf('/')) + '/../assets/provider-logos';
    const urls: { [path: string]: string } = {};
    for (const asset of await readdir(assets)) if (asset.endsWith('.svg')) urls[`../assets/provider-logos/${asset}`] = `${assets}/${asset}`;
    return { contents: source.replace(anchor, JSON.stringify(urls)), loader: 'ts' };
  });
} });
const { SessionNodeItem } = await import('./SessionNodeItem');
// Synthetic DOM evidence, not native/browser/operator proof. No status, hook, helper or row is mocked.
const directory = '/successor-row-fixture';
const A = { generation: 'generation-1', presentationId: 'presentation-A' };
const B = { generation: 'generation-1', presentationId: 'presentation-B' };
let serial = 0, id: string, root: Root, win: Window, host: HTMLElement;
let children: ChildStoreManager, loader: SessionMessageLoader;
let props: SessionNodeItemProps, runtime: ReturnType<typeof useSyncRuntime>;
let previous: Map<string, PropertyDescriptor | undefined>;
let originalStatus: ReturnType<typeof useGlobalSessionStatusStore.getState>;
let originalTiming: ReturnType<typeof useSessionActivityTimingStore.getState>;
let originalOrdering: ReturnType<typeof useSessionOrderingStore.getState>;
const requests: string[] = [];
// SAFETY: sync-context installs this exact stable context globally; existing rendered fixtures use it too.
const Runtime = (globalThis as { __openchamber_sync_runtime_context__?: React.Context<ReturnType<typeof useSyncRuntime> | null> })
  .__openchamber_sync_runtime_context__!;
const noop = () => undefined;
const marker = (state: string) => {
  const dot = host.querySelector('[data-herdr-state]');
  console.log(`ROW ${id}: expected=${state} actual=${dot?.getAttribute('data-herdr-state')}`);
  expect(dot?.getAttribute('data-herdr-state')).toBe(state);
  expect(dot?.getAttribute('aria-label')?.toLowerCase()).toBe(state);
};
const render = () => act(async () => root.render(<I18nProvider><Runtime.Provider value={runtime}>
  <SessionNodeItem {...props} />
</Runtime.Provider></I18nProvider>));
const herdr = async (herdrState: 'working' | 'done') => {
  props = { ...props, node: { ...props.node, session: Object.assign({}, props.node.session, { herdrState }) } };
  await render(); // Same ID/structure: actual exported memo comparator must admit this semantic change.
};
const busy = (ordinaryTarget: SessionStatus['ordinaryTarget']) => act(async () => {
  const status: SessionStatus = { type: 'busy', ordinary: true, ordinaryTarget };
  const event: Event = { id: `${id}:status`, type: 'session.status', properties: { sessionID: id, status } };
  applyGlobalSessionStatusEvent(directory, event);
});
const poll = (ordinaryTarget: SessionStatus['ordinaryTarget']) => act(async () => {
  const status: SessionStatus = { type: 'busy', ordinary: true, ordinaryTarget };
  applyGlobalSessionStatusSnapshot(directory, { [id]: status }, [id]);
});
const completedA = async () => {
  await busy(A); await render(); marker('working');
  await herdr('done'); marker('done');
};

beforeEach(() => {
  id = `native-successor-row-${++serial}`;
  win = new Window({ url: 'http://localhost' });
  requests.length = 0;
  const values = { window: win, document: win.document, navigator: win.navigator, Node: win.Node,
    Element: win.Element, HTMLElement: win.HTMLElement, localStorage: win.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true, fetch: async () => { requests.push('global fetch'); return Response.json([]); } };
  previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  originalStatus = useGlobalSessionStatusStore.getState(); originalTiming = useSessionActivityTimingStore.getState();
  originalOrdering = useSessionOrderingStore.getState();
  replaceGlobalSessionStatusById(new Map());
  children = new ChildStoreManager();
  const sdk = createOpencodeClient({ baseUrl: 'http://fixture.invalid',
    fetch: async () => { requests.push('SDK fetch'); return Response.json([]); } });
  loader = new SessionMessageLoader(children, { sdk, runtimeKey: getRuntimeKey() });
  runtime = { childStores: children, messageLoader: loader, sdk, runtimeKey: getRuntimeKey(),
    currentDirectory: { get: () => '', subscribe: () => noop } };
  const session: Session & { herdrState: string } = { id, slug: id, projectID: 'fixture', directory,
    title: 'Ordinary leaf', version: '1', time: { created: 1, updated: 1 }, herdrState: 'working' };
  children.ensureChild(directory, { bootstrap: false }).setState({ status: 'complete', session: [session] });
  props = { node: { session, children: [], worktree: null }, pinnedSessionIds: new Set(), expandedParents: new Set(),
    hasSessionSearchQuery: false, normalizedSessionSearchQuery: '', notifyOnSubtasks: false,
    editingId: null, setEditingId: noop, editTitle: '', setEditTitle: noop, handleSaveEdit: noop,
    handleCancelEdit: noop, toggleParent: noop, handleSessionSelect: noop, handleSessionDoubleClick: noop,
    handleShareSession: noop, copiedSessionId: null, handleCopyShareUrl: noop, handleCopySessionId: noop,
    handleUnshareSession: noop, openSidebarMenuKey: null, setOpenSidebarMenuKey: noop,
    createFolderAndStartRename: () => null, handleDeleteSession: noop, handleRestoreSession: noop,
    startSessionWorktreeMenuLoad: () => { throw new Error('No worktree action in this fixture'); },
    mobileVariant: false, alwaysShowActions: false, subtreeContainsEditing: new Set(),
    menuOpenSessionId: null, nodeStructureKey: `${id}:0` };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); loader.dispose(); children.disposeAll();
  useGlobalSessionStatusStore.setState(originalStatus, true);
  useSessionActivityTimingStore.setState(originalTiming, true);
  useSessionOrderingStore.setState(originalOrdering, true);
  await win.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
  expect(requests).toEqual([]); // A row mount/status update starts no bootstrap, task API, or other IO.
});

test('baseline: completed A stays Done on same-target busy polls, NULL gap, same A, and genuine idle deletion', async () => {
  await completedA();
  await poll({ ...A }); marker('done');
  await busy(null); marker('done');
  await busy({ ...A }); marker('done');
  await poll({ ...A }); marker('done');
  await act(async () => applyGlobalSessionStatusEvent(directory, { id: `${id}:idle`, type: 'session.idle', properties: { sessionID: id } }));
  expect(useGlobalSessionStatusStore.getState().statusById.has(id)).toBe(false); marker('done');
});
test('new B target alone makes actual subscribed memo row Working while Herdr stays Done; identical polls stay Working', async () => {
  await completedA();
  const stableNode = props.node;
  const statusA = useGlobalSessionStatusStore.getState().statusById.get(id)?.status;
  await busy(B); // No parent render: type stays busy; only the rich target changes.
  expect(props.node).toBe(stableNode);
  expect(useGlobalSessionStatusStore.getState().statusById.get(id)?.status).not.toBe(statusA);
  expect(useGlobalSessionStatusStore.getState().statusById.get(id)?.status.ordinaryTarget).toEqual(B);
  marker('working'); // Baseline RED must fail here, after A's controls passed.
  await poll({ ...B }); marker('working');
  await poll({ ...B }); marker('working');
});
test('same presentation in a new generation is a genuine busy boundary', async () => {
  await completedA(); await busy({ ...A, generation: 'generation-2' }); marker('working');
});
test('a collapsed/remounted row lets current native busy win over completed Herdr sample', async () => {
  await completedA();
  await act(async () => root.render(null));
  await busy(B); await render(); marker('working');
  await poll({ ...B }); marker('working');
});
