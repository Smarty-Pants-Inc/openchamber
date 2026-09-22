import '@/sync/native-test-network';
import React, { act } from 'react';
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { nativeComposerDom } from '../submit/__tests__/nativeComposer-dom';
import type { NativeCreationReply, NativeCreationState } from '@/lib/opencode/nativeCreation';
const dom = nativeComposerDom();
mock.module('@/lib/search/fuzzySearch', () => ({ matchesFuzzyQuery: () => false }));
const { I18nProvider } = await import('@/lib/i18n');
const { NativeCreationNotice } = await import('./NativeCreationNotice');
const { useNativeCreation } = await import('../state/useNativeCreation');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { opencodeClient } = await import('@/lib/opencode/client');
const { getRuntimeKey } = await import('@/lib/runtime-switch');
const { nativeDraftFixture, session, directory, deferred } = await import('@/sync/native-draft-fixture');
const { NATIVE_CREATION_INVALIDATED } = await import('@/lib/opencode/nativeCreation');
let fixture: ReturnType<typeof nativeDraftFixture>, root: Root;
let restoreFetch: () => void;
let operation: NativeCreationState, listed: NativeCreationState[];
let detail: () => Promise<Response>, reply: (body: NativeCreationReply) => Promise<Response>;
const operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', endpoint = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const generation = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
function Caller() {
  const draft = useSessionUIStore(state => state.newSessionDraft);
  const selected = useSessionUIStore(state => state.currentSessionId);
  const native = useNativeCreation(draft, selected, '/wrong-default', getRuntimeKey());
  return <NativeCreationNotice native={native} draftOpen={draft.open} />;
}
const button = (label: string) => [...dom.container.querySelectorAll('button')].find(b => b.textContent === label)!;
async function click(label: string) {
  const control = button(label); expect(control).toBeDefined(); expect(control.disabled).toBe(false);
  await act(async () => { control.click(); });
}
const replies = () => fixture.requests.filter(r => new URL(r.url).pathname.endsWith('/reply'));
async function setup() {
  fixture = nativeDraftFixture();
  opencodeClient.setDirectory('/wrong-default');
  operation = { operationId, directory, generation: endpoint, revision: 1, phase: 'awaiting-trust', expiresAt: Date.now() + 60_000, canInitialReady: false };
  listed = [];
  fixture.handlers.health = async () => Response.json({ healthy: true, capabilities: { ordinaryInteractiveCreate: 1 } });
  fixture.handlers.create = async () => { listed = [operation]; return Response.json({ nativeCreation: operation }, { status: 202 }); };
  detail = async () => Response.json({ ...session, nativeCreation: undefined,
    ordinary: { generation, sequence: 1, model: { providerID: 'cliproxyapi', modelID: 'gpt-6-astra', name: 'GPT-6 Astra' }, thinkingLevel: 'medium' } });
  reply = async body => {
    expect(body.generation).toBe(endpoint); expect(body.revision).toBe(operation.revision);
    operation = { ...operation, revision: operation.revision + 1,
      phase: body.action === 'trust' ? 'ready-required' : body.action === 'ready' ? 'ready' : body.action === 'deny' ? 'denied' : 'cancelled' };
    if (body.action === 'trust') {
      operation.native = { id: session.id, generation };
      operation.canInitialReady = true;
    }
    listed = [operation]; return Response.json({ nativeCreation: operation });
  };
  const originalFetch = globalThis.fetch;
  restoreFetch = () => { globalThis.fetch = originalFetch; };
  // SAFETY: This fixture uses fetch's callable API, not Bun preconnect; unhandled requests forward unchanged.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    if (path.includes('/session/creation') || path.endsWith(`/session/${session.id}`)) {
      fixture.requests.push(request.clone());
      expect(new URL(request.url).searchParams.get('directory')).toBe(directory);
      if (path.endsWith('/creation')) return Response.json({ nativeCreations: listed });
      if (path.endsWith('/reply')) return reply(await request.json());
      if (path.endsWith(`/creation/${operationId}`)) return Response.json({ nativeCreation: operation });
      return detail();
    }
    if (path.endsWith('/fs/home')) return Response.json({ home: '/synthetic-home' });
    return originalFetch(input, init);
  }) as typeof fetch;
  root = createRoot(dom.container);
  await act(async () => root.render(<I18nProvider><Caller /></I18nProvider>));
}
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  restoreFetch?.(); fixture?.dispose();
  globalThis.fetch = async () => { throw new Error('Native choice fixture network denied after teardown'); };
});
afterAll(() => dom.restore());

test('actual notice clicks traverse hook/client: 202, session-only trust, explicit ready, exact native GET before materialization', async () => {
  await setup();
  await click('Create native Pi session');
  expect(fixture.creates()).toHaveLength(1); expect(replies()).toHaveLength(0);
  expect(button('Enable initial browser input')).toBeUndefined();
  expect(dom.container.textContent).toContain('this session only');
  await click('Trust for this session');
  expect(await replies()[0].clone().json()).toEqual({ action: 'trust', generation: endpoint, revision: 1 });
  expect(replies()).toHaveLength(1); expect(button('Enable initial browser input')).toBeDefined();
  const held = deferred<Response>(); detail = () => held.promise;
  await click('Enable initial browser input');
  expect(await replies()[1].clone().json()).toEqual({ action: 'ready', generation: endpoint, revision: 2, native: { id: session.id, generation } });
  expect([...useSessionUIStore.getState().nativeDraftCreations.values()][0].status).toBe('pending');
  expect(useSessionUIStore.getState().currentSessionId).toBeNull();
  expect((useGlobalSessionsStore.getState().sessionsByDirectory.get(directory) ?? []).some(row => row.id === session.id)).toBe(false);
  await act(async () => held.resolve(Response.json({ ...session, nativeCreation: undefined,
    ordinary: { generation, sequence: 2, model: { providerID: 'cliproxyapi', modelID: 'gpt-6-astra', name: 'GPT-6 Astra' }, thinkingLevel: 'medium' } })));
  expect(dom.container.textContent).toContain('cliproxyapi/gpt-6-astra');
  expect(dom.container.textContent).toContain('Use Send explicitly');
  expect(fixture.creates()).toHaveLength(1); expect(replies()).toHaveLength(2); expect(fixture.prompts()).toHaveLength(0);
  expect(useSessionUIStore.getState().newSessionDraft.initialPrompt).toBe('Keep @notes.md');
});

test('reopen discovers owned operation through list/read; invalidation re-reads without Create or reply', async () => {
  await setup();
  listed = [operation];
  await act(async () => window.dispatchEvent(new CustomEvent(NATIVE_CREATION_INVALIDATED,
    { detail: { directory, runtimeKey: fixture.runtimeA } })));
  await click(`${operationId} · awaiting-trust`);
  expect(button('Trust for this session')).toBeDefined();
  await act(async () => { operation = { ...operation, revision: 2, phase: 'denied' };
    window.dispatchEvent(new CustomEvent(NATIVE_CREATION_INVALIDATED, { detail: { directory, runtimeKey: fixture.runtimeA } })); });
  expect(dom.container.textContent).toContain('denied');
  expect(button('Trust for this session')).toBeUndefined();
  expect(fixture.creates()).toHaveLength(0); expect(replies()).toHaveLength(0); expect(fixture.prompts()).toHaveLength(0);
});

for (const action of ['Deny trust', 'Cancel creation']) test(`explicit ${action} has no ready or prompt side effect`, async () => {
  await setup(); await click('Create native Pi session'); await click(action);
  expect(replies()).toHaveLength(1); expect(button('Enable initial browser input')).toBeUndefined();
  expect([...useSessionUIStore.getState().nativeDraftCreations.values()][0].status).toBe('pending');
  expect(fixture.prompts()).toHaveLength(0);
});

test('stale/unknown reply is not replayed; only an explicit read restores choice', async () => {
  await setup(); await click('Create native Pi session');
  reply = async () => Response.json({ name: 'APIError', data: { message: 'Changed' } }, { status: 409 });
  await click('Trust for this session');
  expect(replies()).toHaveLength(1); expect(button('Trust for this session').disabled).toBe(true);
  await click('Read current creation status');
  expect(replies()).toHaveLength(1); expect(button('Trust for this session').disabled).toBe(false);
  expect(fixture.creates()).toHaveLength(1); expect(fixture.prompts()).toHaveLength(0);
});

test('ready ACK with mismatched native generation cannot index or select a session', async () => {
  await setup(); await click('Create native Pi session'); await click('Trust for this session');
  detail = async () => Response.json({ ...session, ordinary: { generation: endpoint, sequence: 1,
    model: { providerID: 'p', modelID: 'm', name: 'Wrong' }, thinkingLevel: 'medium' } });
  await click('Enable initial browser input');
  expect([...useSessionUIStore.getState().nativeDraftCreations.values()][0].status).toBe('pending');
  expect(useSessionUIStore.getState().currentSessionId).toBeNull();
  expect((useGlobalSessionsStore.getState().sessionsByDirectory.get(directory) ?? []).some(row => row.id === session.id)).toBe(false);
  expect(fixture.prompts()).toHaveLength(0);
});

for (const boundary of ['reply', 'native GET']) for (const change of ['runtime', 'draft', 'project']) {
  test(`${change} change while ${boundary} is held cannot materialize or select`, async () => {
    await setup(); await click('Create native Pi session');
    const held = deferred<Response>();
    if (boundary === 'native GET') { await click('Trust for this session'); detail = () => held.promise; }
    else reply = () => held.promise;
    await click(boundary === 'reply' ? 'Trust for this session' : 'Enable initial browser input');
    await act(async () => {
      if (change === 'runtime') fixture.switchRuntime('other-runtime');
      else if (change === 'draft') fixture.target('b', '/native-project-b');
      else useProjectsStore.setState({ managedCatalogAdmitted: true, managedCatalogStatus: 'unavailable' });
      held.resolve(boundary === 'reply' ? Response.json({ nativeCreation: { ...operation,
        revision: operation.revision + 1, phase: 'ready-required', native: { id: session.id, generation }, canInitialReady: true } })
        : Response.json({ ...session, ordinary: { generation, sequence: 1, model: { providerID: 'p', modelID: 'm', name: 'Native' }, thinkingLevel: 'medium' } }));
    });
    expect(useSessionUIStore.getState().currentSessionId).toBeNull();
    expect((useGlobalSessionsStore.getState().sessionsByDirectory.get(directory) ?? []).some(row => row.id === session.id)).toBe(false);
    expect(fixture.creates()).toHaveLength(1); expect(fixture.prompts()).toHaveLength(0);
    expect(replies()).toHaveLength(boundary === 'reply' ? 1 : 2);
  });
}

test('two actual clicks while trust is held produce one reply and no replay', async () => {
  await setup(); await click('Create native Pi session');
  const held = deferred<Response>(); reply = () => held.promise;
  const trust = button('Trust for this session');
  await act(async () => { trust.click(); trust.click(); });
  expect(replies()).toHaveLength(1);
  await act(async () => held.resolve(Response.json({ nativeCreation: { ...operation, revision: 2, phase: 'denied' } })));
  expect(replies()).toHaveLength(1); expect(fixture.creates()).toHaveLength(1); expect(fixture.prompts()).toHaveLength(0);
});


test('fresh draft can explicitly create once while owned list retains a settled ready operation', async () => {
  await setup();
  listed = [{ ...operation, phase: 'ready', native: { id: session.id, generation } }];
  await act(async () => window.dispatchEvent(new CustomEvent(NATIVE_CREATION_INVALIDATED,
    { detail: { directory, runtimeKey: fixture.runtimeA } })));
  expect(fixture.creates()).toHaveLength(0); expect(replies()).toHaveLength(0);
  const nextId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  fixture.handlers.create = async () => Response.json({ nativeCreation: { ...operation, operationId: nextId } }, { status: 202 });
  await click('Create native Pi session');
  expect(fixture.creates()).toHaveLength(1); expect(replies()).toHaveLength(0); expect(fixture.prompts()).toHaveLength(0);
  expect(useSessionUIStore.getState().currentSessionId).toBeNull();
  const record = [...useSessionUIStore.getState().nativeDraftCreations.values()][0];
  expect(record.status).toBe('pending');
  if (record.status === 'pending') expect(record.operation.operationId).toBe(nextId);
  expect((useGlobalSessionsStore.getState().sessionsByDirectory.get(directory) ?? []).some(row => row.id === session.id)).toBe(false);
});

for (const phase of ['awaiting-trust', 'unavailable'] as const) test(`fresh draft still blocks Create for retained ${phase} operation`, async () => {
  await setup(); listed = [{ ...operation, phase }];
  await act(async () => window.dispatchEvent(new CustomEvent(NATIVE_CREATION_INVALIDATED,
    { detail: { directory, runtimeKey: fixture.runtimeA } })));
  expect(button('Create native Pi session')).toBeUndefined();
  expect(fixture.creates()).toHaveLength(0); expect(replies()).toHaveLength(0); expect(fixture.prompts()).toHaveLength(0);
});
