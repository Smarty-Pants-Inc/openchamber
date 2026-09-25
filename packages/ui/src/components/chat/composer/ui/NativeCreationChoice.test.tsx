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
let sendResult: Promise<unknown> | undefined;
/** The notice, plus the composer's Send reduced to its first step (ChatInput calls beforeSend, then sends). */
function Caller() {
  const draft = useSessionUIStore(state => state.newSessionDraft);
  const selected = useSessionUIStore(state => state.currentSessionId);
  const native = useNativeCreation(draft, selected, '/wrong-default', getRuntimeKey());
  return <>
    <NativeCreationNotice native={native} draftOpen={draft.open} />
    <button type="button" onClick={() => { sendResult = native.beforeSend(); sendResult.catch(() => undefined); }}>Send</button>
  </>;
}
const button = (label: string) => [...dom.container.querySelectorAll('button')].find(b => b.textContent === label)!;
async function click(label: string) {
  const control = button(label); expect(control).toBeDefined(); expect(control.disabled).toBe(false);
  await act(async () => { control.click(); });
}
const replies = () => fixture.requests.filter(r => new URL(r.url).pathname.endsWith('/reply'));
async function setup() {
  fixture = nativeDraftFixture();
  // A stock runtime: discovery has answered, so the capability check may run.
  useProjectsStore.setState({ managedCatalogStatus: 'stock' });
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
  restoreFetch?.(); fixture?.dispose(); localStorage.removeItem('oc.nativeCreation.mine');
  globalThis.fetch = async () => { throw new Error('Native choice fixture network denied after teardown'); };
});
afterAll(() => dom.restore());

// smarty-code#126: a person never sees a separate create, trust or first-input step, or native jargon.
test('Send starts the session with no separate step; the notice only says it is starting and offers Cancel', async () => {
  await setup();
  expect(dom.container.textContent).toBe('Send');
  const held = deferred<Response>(); const answered = reply; reply = () => held.promise;
  await click('Send');
  expect(fixture.creates()).toHaveLength(1); expect(replies()).toHaveLength(1);
  expect(dom.container.textContent).toContain('Starting a new session in this project');
  expect(button('Send')).toBeDefined();
  reply = answered;
  await act(async () => { held.resolve(await answered({ action: 'trust', generation: endpoint, revision: 1 })); await sendResult; });
  expect(replies()).toHaveLength(2);
  expect(await replies()[1].clone().json()).toEqual({ action: 'ready', generation: endpoint, revision: 2, native: { id: session.id, generation } });
  expect(dom.container.textContent).toBe('Send');
  expect(fixture.creates()).toHaveLength(1); expect(fixture.prompts()).toHaveLength(0);
  expect(useSessionUIStore.getState().newSessionDraft.initialPrompt).toBe('Keep @notes.md');
  expect(/native|trust|\/code-ready|Herdr/i.test(dom.container.textContent ?? '')).toBe(false);
});

test('Cancel while starting stops the start; nothing is sent and the draft stays', async () => {
  await setup();
  // The session is still starting (no trust question yet): Send waits and re-reads.
  fixture.handlers.create = async () => { operation = { ...operation, phase: 'starting' }; listed = [operation];
    return Response.json({ nativeCreation: operation }, { status: 202 }); };
  await click('Send');
  await click('Cancel');
  await act(async () => { await sendResult?.catch(() => undefined); });
  expect(await replies()[0].clone().json()).toEqual({ action: 'cancel', generation: endpoint, revision: 1 });
  expect(await sendResult?.then(() => 'resolved', (error: { code?: string }) => error.code)).toBe('stopped');
  expect(fixture.creates()).toHaveLength(1); expect(fixture.prompts()).toHaveLength(0);
  expect(useSessionUIStore.getState().newSessionDraft.initialPrompt).toBe('Keep @notes.md');
});

test('a start from another window is named in plain words and never taken over by Send', async () => {
  await setup();
  listed = [operation];
  await act(async () => window.dispatchEvent(new CustomEvent(NATIVE_CREATION_INVALIDATED,
    { detail: { directory, runtimeKey: fixture.runtimeA } })));
  expect(dom.container.textContent).toContain('another window or on another device');
  await click('Send');
  await act(async () => { await sendResult?.catch(() => undefined); });
  expect(fixture.creates()).toHaveLength(0); expect(replies()).toHaveLength(0); expect(fixture.prompts()).toHaveLength(0);
});

test('an unknown outcome says so in plain words, and Send never creates again', async () => {
  await setup();
  reply = async () => Response.json({ name: 'APIError', data: { message: 'Changed' } }, { status: 409 });
  await click('Send');
  await act(async () => { await sendResult?.catch(() => undefined); });
  expect(dom.container.querySelector('[role="alert"]')).not.toBeNull();
  await click('Send');
  await act(async () => { await sendResult?.catch(() => undefined); });
  expect(fixture.creates()).toHaveLength(1); expect(replies()).toHaveLength(1); expect(fixture.prompts()).toHaveLength(0);
  expect(useSessionUIStore.getState().currentSessionId).toBeNull();
  expect((useGlobalSessionsStore.getState().sessionsByDirectory.get(directory) ?? []).some(row => row.id === session.id)).toBe(false);
});
