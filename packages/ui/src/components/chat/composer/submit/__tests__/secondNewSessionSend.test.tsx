import { afterEach, expect, test } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { act } from 'react';
import type { NativeCreationState } from '@/lib/opencode/nativeCreation';
import { mountedNativeComposer } from './nativeComposer.fixture';
import { session, directory } from '@/sync/native-draft-fixture';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { resetNativeDraftPage } from '@/sync/native-draft-start';
import { resetSentStartsForPage } from '@/sync/native-draft-sent';

// smarty-code#114 (Release 3.32, the fresh repeat leg): after a first New session → Send whose session opened, a second
// New session → type → Send did nothing: the composer's list read, begun 0.8 s before the first start settled ready,
// still showed it "starting", and Send refused locally with no request and no lasting word why.
let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
let restoreFetch = () => {};
afterEach(async () => {
  // The sent marks (#117) and request ids are page storage: clear them before the page's DOM goes.
  globalThis.localStorage?.clear(); globalThis.sessionStorage?.clear();
  restoreFetch(); restoreFetch = () => {}; await mounted?.dispose(); mounted = undefined; resetNativeDraftPage(); resetSentStartsForPage();
});
const settle = () => act(async () => { for (let i = 0; i < 40; i++) await sleep(1); });
const operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', endpoint = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const generation = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ordinary = { generation, sequence: 1, model: { providerID: 'cliproxyapi', modelID: 'gpt-6-astra', name: 'GPT-6 Astra' }, thinkingLevel: 'medium' };

/** An interactive gateway: 202 starts, trust and first-input answers, and a list of starts the test controls. */
function interactiveServer(fixture: Awaited<ReturnType<typeof mountedNativeComposer>> | Parameters<NonNullable<Parameters<typeof mountedNativeComposer>[4]>>[0]) {
  const state = { operation: undefined as NativeCreationState | undefined, list: () => (state.operation ? [state.operation] : []) as NativeCreationState[] };
  fixture.handlers.health = async () => Response.json({ healthy: true, capabilities: { ordinaryInteractiveCreate: 1, creationClientRequestId: 1 } });
  let starts = 0;
  fixture.handlers.create = async (request: Request) => {
    const sent = await request.clone().text();
    // Each start is its own operation, as on a real gateway.
    const id = starts++ === 0 ? operationId : `aaaaaaaa-aaaa-4aaa-8aaa-${String(starts).padStart(12, '0')}`;
    state.operation = { operationId: id, directory, generation: endpoint, revision: 1, phase: 'awaiting-trust', expiresAt: Date.now() + 60_000,
      canInitialReady: false, ...(sent ? { clientRequestId: JSON.parse(sent).clientRequestId } : {}) };
    return Response.json({ nativeCreation: state.operation }, { status: 202 });
  };
  const inner = globalThis.fetch;
  restoreFetch = () => { globalThis.fetch = inner; };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    if (path.includes('/session/creation') || path.endsWith(`/session/${session.id}`)) {
      fixture.requests.push(request.clone());
      if (path.endsWith('/creation')) return Response.json({ nativeCreations: state.list() });
      if (path.endsWith('/reply')) {
        const body = await request.json() as { action: string };
        const op = state.operation!;
        state.operation = body.action === 'trust'
          ? { ...op, revision: op.revision + 1, phase: 'ready-required', native: { id: session.id, generation }, canInitialReady: true }
          : { ...op, revision: op.revision + 1, phase: 'ready' };
        return Response.json({ nativeCreation: state.operation });
      }
      if (/\/creation\/[^/]+$/.test(path)) return Response.json({ nativeCreation: state.operation });
      return Response.json({ ...session, nativeCreation: undefined, ordinary });
    }
    return inner(input, init);
  }) as typeof fetch;
  return state;
}

test('a second New session right after the first one opened: Send creates the second session', async () => {
  let server!: ReturnType<typeof interactiveServer>;
  const c = mounted = await mountedNativeComposer(false, undefined, undefined, undefined, fixture => { server = interactiveServer(fixture); });
  useProjectsStore.setState({ managedCatalogStatus: 'stock' });
  await c.replace('Round 1'); await c.submit(); await settle();
  expect(c.creates()).toHaveLength(1); expect(c.prompts()).toHaveLength(1);
  expect(useSessionUIStore.getState().currentSessionId).toBe(session.id); // Round 1's session opened.
  // The composer's next list read began before round 1 settled: it still shows round 1 "ready-required".
  const settled = server.operation!;
  let staleReads = 1;
  server.list = () => staleReads-- > 0 ? [{ ...settled, phase: 'ready-required' }] : [settled];
  await act(async () => { useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: 'a', directoryOverride: directory }); });
  await settle();
  await c.replace('Round 2'); await c.submit(); await settle();
  expect(c.creates()).toHaveLength(2);
  for (let i = 0; i < 50 && c.prompts().length < 2; i++) await settle(); // Round 2 finishes: its message is sent once.
  expect(c.prompts()).toHaveLength(2);
  expect(c.dom.container.querySelector('[role="alert"]')).toBeNull();
});

test('a Send refused before anything is sent says why, and the words stay (not a passing toast)', async () => {
  let server!: ReturnType<typeof interactiveServer>;
  const c = mounted = await mountedNativeComposer(false, undefined, undefined, undefined, fixture => { server = interactiveServer(fixture); });
  useProjectsStore.setState({ managedCatalogStatus: 'stock' });
  // The composer saw another start here; Send's own fresh read of it fails, so Send refuses and sends nothing.
  const other: NativeCreationState = { operationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', directory, generation: endpoint, revision: 1,
    phase: 'starting', expiresAt: Date.now() + 60_000, canInitialReady: false };
  let reads = 0;
  server.list = () => { if (reads++ > 0) throw new Error('connection reset'); return [other]; };
  await act(async () => { useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: 'a', directoryOverride: directory }); });
  await settle();
  await c.replace('Keep this'); await c.submit(); await settle();
  expect(c.creates()).toHaveLength(0);
  expect(c.text()).toBe('Keep this');
  const alert = () => c.dom.container.querySelector('[role="alert"]')?.textContent ?? '';
  expect(alert()).toContain('Nothing was sent');
  await act(async () => { await sleep(50); });
  expect(alert()).toContain('Nothing was sent'); // It stays until the next Send.
});

test("a refusal in one project is not shown after the draft switches to another project", async () => {
  let server!: ReturnType<typeof interactiveServer>;
  const c = mounted = await mountedNativeComposer(false, undefined, undefined, undefined, fixture => { server = interactiveServer(fixture); });
  useProjectsStore.setState({ managedCatalogStatus: 'stock' });
  const other: NativeCreationState = { operationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', directory, generation: endpoint, revision: 1,
    phase: 'starting', expiresAt: Date.now() + 60_000, canInitialReady: false };
  let reads = 0;
  server.list = () => { if (reads++ > 0) throw new Error('connection reset'); return [other]; };
  await act(async () => { useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: 'a', directoryOverride: directory }); });
  await settle();
  await c.replace('Keep this'); await c.submit(); await settle();
  expect(c.dom.container.querySelector('[role="alert"]')?.textContent ?? '').toContain('Nothing was sent');
  server.list = () => [];
  await act(async () => { c.target('b', '/native-project-b'); }); await settle(); // The same draft, another project.
  expect(c.dom.container.querySelector('[role="alert"]')).toBeNull();
});
