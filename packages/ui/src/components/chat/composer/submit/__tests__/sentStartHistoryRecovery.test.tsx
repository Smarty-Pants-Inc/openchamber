import { afterAll, afterEach, expect, test } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { act } from 'react';
import type { NativeCreationState } from '@/lib/opencode/nativeCreation';
import { nativeComposerDom } from './nativeComposer-dom';

// Storage must bind this window before the composer loads (nativeComposer-storage's order): the saved drafts and the
// sent marks then share one localStorage, as on a real page.
const dom = nativeComposerDom();
const { getDeferredSafeStorage, getSafeStorage } = await import('@/stores/utils/safeStorage');
const { mountedNativeComposer } = await import('./nativeComposer.fixture');
const { session, directory, deferred } = await import('@/sync/native-draft-fixture');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { useInputStore } = await import('@/sync/input-store');
const { resetNativeDraftPage } = await import('@/sync/native-draft-start');
const { resetSentStartsForPage } = await import('@/sync/native-draft-sent');
afterAll(async () => { await dom.restore(); });

// smarty-code#461: the two known limits of the #117 sent-start guard (openchamber#220 review) as MOUNTED-composer
// repros. A Send's prompt reply is lost (the page closes while it is in flight); after the reload, the sent mark's
// recovery reads the start and its session history. Each test asserts the CORRECT behaviour.
let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
let restoreFetch = () => {};
afterEach(async () => {
  getDeferredSafeStorage().clear(); globalThis.localStorage?.clear(); globalThis.sessionStorage?.clear();
  restoreFetch(); restoreFetch = () => {}; await mounted?.dispose(); mounted = undefined; resetNativeDraftPage(); resetSentStartsForPage();
});
const settle = () => act(async () => { for (let i = 0; i < 40; i++) await sleep(1); });
const operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', endpoint = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const generation = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ordinary = { generation, sequence: 1, model: { providerID: 'cliproxyapi', modelID: 'gpt-6-astra', name: 'GPT-6 Astra' }, thinkingLevel: 'medium' };

/** secondNewSessionSend's interactive gateway: 202 starts, trust and first-input answers. */
function interactiveServer(fixture: Parameters<NonNullable<Parameters<typeof mountedNativeComposer>[4]>>[0]) {
  let current: NativeCreationState | undefined;
  fixture.handlers.health = async () => Response.json({ healthy: true, capabilities: { ordinaryInteractiveCreate: 1, creationClientRequestId: 1 } });
  fixture.handlers.create = async (request: Request) => {
    const sent = await request.clone().text();
    const operation: NativeCreationState = { operationId, directory, generation: endpoint, revision: 1, phase: 'awaiting-trust',
      expiresAt: Date.now() + 60_000, canInitialReady: false };
    if (sent) operation.clientRequestId = JSON.parse(sent).clientRequestId;
    current = operation;
    return Response.json({ nativeCreation: current }, { status: 202 });
  };
  const inner = globalThis.fetch;
  restoreFetch = () => { globalThis.fetch = inner; };
  // SAFETY: a test double for the global fetch; it takes and returns the same Request/Response shapes.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    if (path.includes('/session/creation') || path.endsWith(`/session/${session.id}`)) {
      fixture.requests.push(request.clone());
      if (path.endsWith('/creation')) return Response.json({ nativeCreations: current ? [current] : [] });
      if (path.endsWith('/reply')) {
        // SAFETY: the page's own reply body, `{ action }`, the only reply the gateway double serves.
        const body = await request.json() as { action: string };
        const op = current!;
        current = body.action === 'trust'
          ? { ...op, revision: op.revision + 1, phase: 'ready-required', native: { id: session.id, generation }, canInitialReady: true }
          : { ...op, revision: op.revision + 1, phase: 'ready' };
        return Response.json({ nativeCreation: current });
      }
      if (/\/creation\/[^/]+$/.test(path)) return Response.json({ nativeCreation: current });
      return Response.json({ ...session, nativeCreation: undefined, ordinary });
    }
    return inner(input, init);
  }) as typeof fetch;
}

type Mounted = Awaited<ReturnType<typeof mountedNativeComposer>>;
const newSession = () => act(async () => { useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: 'a', directoryOverride: directory }); });
const sentKey = (c: Mounted) => `oc.nativeCreation.sent:${JSON.stringify([c.runtimeA, directory])}`;
// This tab's New session slot (its own storage key since smarty-code#461).
const slot = () => {
  const storage = getSafeStorage();
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index) ?? '');
  const found = keys.find(key => key.startsWith('openchamber.chatDraftSlot:') && key.includes(JSON.stringify(directory).slice(1, -1)));
  // SAFETY: the slot this page itself wrote.
  return found ? (JSON.parse(storage.getItem(found) ?? '{}') as { text?: string }).text ?? '' : '';
};
const deliveredHello = [{ info: { id: 'msg_1', sessionID: session.id, role: 'user', time: { created: 1 } },
  parts: [{ id: 'prt_1', type: 'text', text: 'hello' }] }];

/** New session → type `hello` → Send; the prompt POST reaches the server but its reply never comes back. */
async function sendHelloReplyLost() {
  const c = mounted = await mountedNativeComposer(true, dom, undefined, undefined, fixture => {
    interactiveServer(fixture);
    fixture.handlers.prompt = () => new Promise<Response>(() => {}); // Delivered; the reply is lost.
  });
  useProjectsStore.setState({ managedCatalogStatus: 'stock' });
  await newSession(); await settle();
  await c.replace('hello'); await c.submit();
  for (let i = 0; i < 40 && c.prompts().length < 1; i++) await settle();
  expect(c.creates()).toHaveLength(1); expect(c.prompts()).toHaveLength(1);
  return c;
}

/** The page closes (its locks and in-memory Send go; the mark and saved draft stay) and loads again. */
async function reload(c: Mounted) {
  await act(async () => { window.dispatchEvent(new Event('pagehide')); }); // The tab closes: its editor's text is saved.
  await act(async () => {
    sessionStorage.clear(); resetNativeDraftPage(); resetSentStartsForPage();
    useSessionUIStore.setState({ nativeDraftCreations: new Map(), currentSessionId: null, currentSessionDirectory: null });
  });
  await newSession();
  await act(async () => { c.remount(); });
}

/** Session-history reads after the reload: each held until the test releases it. */
function holdHistory(c: Mounted) {
  const reads: Array<ReturnType<typeof deferred<void>>> = [];
  c.handlers.history = async () => {
    const gate = deferred<void>(); reads.push(gate);
    await gate.promise;
    return Response.json(deliveredHello);
  };
  return reads;
}

test('#461 repro 1: recovery history held across New session, both reads released: the delivered text is not sent again', async () => {
  const c = await sendHelloReplyLost();
  const reads = holdHistory(c);
  await reload(c);
  for (let i = 0; i < 20 && reads.length < 1; i++) await settle();
  expect(c.text()).toBe('hello'); // The reloaded page holds the sent copy; its recovery read is held.
  expect(reads.length).toBeGreaterThanOrEqual(1); // The recovery's history read is held.
  const before = reads.length;
  await newSession(); // New session in the same project, while that read is held.
  for (let i = 0; i < 20 && reads.length <= before; i++) await settle();
  expect(reads.length).toBeGreaterThan(before); // New session's own recovery read, held too.
  for (const read of reads) { await act(async () => { read.resolve(); }); await settle(); }
  for (let i = 0; i < 5; i++) await settle();
  await c.submit(); // The person presses Send on what the composer now shows.
  for (let i = 0; i < 20; i++) await settle();
  expect(c.creates()).toHaveLength(1);
  expect(c.prompts()).toHaveLength(1);
  expect(c.text()).toBe(''); // Found delivered: consumed, never offered again.
});

test('recovery consumes old files but preserves a newly attached file for an explicit attachment-only Send', async () => {
  const c = await sendHelloReplyLost();
  const reads = holdHistory(c);
  await reload(c);
  for (let i = 0; i < 20 && reads.length < 1; i++) await settle();
  expect(reads.length).toBeGreaterThanOrEqual(1);
  await newSession();
  for (let i = 0; i < 20 && reads.length < 2; i++) await settle();
  const freshFile = { id: 'fresh-file', filename: 'fresh.txt', mimeType: 'text/plain',
    dataUrl: 'data:text/plain;base64,ZnJlc2g=', source: 'local' as const,
    file: new File(['fresh'], 'fresh.txt', { type: 'text/plain' }), size: 5 };
  await act(async () => {
    useInputStore.getState().setAttachedFiles([...useInputStore.getState().attachedFiles, freshFile]);
    c.remount(); // The epoch boundary must not reclassify the newer file as submitted.
  });
  for (const read of reads) { await act(async () => { read.resolve(); }); await settle(); }
  expect(c.text()).toBe('');
  expect(useInputStore.getState().attachedFiles).toEqual([freshFile]);
  expect(c.creates()).toHaveLength(1);
  expect(c.prompts()).toHaveLength(1);
  // A different attachment is new input, not a duplicate of the recovered Send.
  c.handlers.history = async () => Response.json(deliveredHello);
  c.handlers.prompt = async () => new Response(null, { status: 204 });
  await c.submit();
  for (let i = 0; i < 20 && c.prompts().length < 2; i++) await settle();
  expect(c.creates()).toHaveLength(2);
  expect(c.prompts()).toHaveLength(2);
  const body = await c.prompts()[1].json();
  expect(body.parts.some((part: { type: string; filename?: string }) => part.type === 'file' && part.filename === 'fresh.txt')).toBe(true);
});

test('#461 repro 2: reply lost, edited away and back to the same words, saved, reloaded: recovery keeps the newer draft', async () => {
  const c = await sendHelloReplyLost();
  await sleep(5);
  await c.replace('hello!'); await c.replace('hello'); // Away and back: a new message with the same words.
  await act(async () => { await sleep(700); }); // The save debounce.
  expect(slot()).toBe('hello');
  const reads = holdHistory(c);
  await reload(c);
  for (let i = 0; i < 20 && reads.length < 1; i++) await settle();
  for (const read of reads) { await act(async () => { read.resolve(); }); await settle(); }
  for (let i = 0; i < 5; i++) await settle();
  expect(JSON.parse(localStorage.getItem(sentKey(c))!)).toMatchObject({ admitted: true, text: 'hello' }); // History confirmed it.
  expect(reads.length).toBeGreaterThanOrEqual(1); // History was read (the recovery ran).
  expect(c.text()).toBe('hello'); // The newer unsent draft stays in the editor...
  await act(async () => { await sleep(700); });
  expect(slot()).toBe('hello'); // ...and saved.
});
