import type { NativeCreationReply, NativeCreationState } from '@/lib/opencode/nativeCreation';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useInputStore } from './input-store';
import { nativeCreationForDraft, preparedNativeDraft } from './native-draft-creation';
import { noteNativeDraftSubmitted, prepareNativeDraftSend, type NativeDraftSend } from './native-draft-send';
import { directory, nativeDraftFixture, session } from './native-draft-fixture';
import { resetNativeDraftPage } from './native-draft-start';
import { resetSentStartsForPage } from './native-draft-sent';
import { useSessionUIStore } from './session-ui-store';

/** Test harness: an interactive-creation gateway whose answers each test can change (`h`). Not product code. */
// Bun has no sessionStorage; the start keeps this tab's create request id there.
const tab = new Map<string, string>();
if (!('localStorage' in globalThis)) {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); }, clear: () => { store.clear(); } } });
}
if (!('sessionStorage' in globalThis)) Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
  getItem: (key: string) => tab.get(key) ?? null, setItem: (key: string, value: string) => { tab.set(key, value); },
  removeItem: (key: string) => { tab.delete(key); }, clear: () => { tab.clear(); } } });

/** Web Locks this page holds (Bun has none). */
export const heldLocks = new Set<string>();
if (!globalThis.navigator?.locks) Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { ...globalThis.navigator, locks: {
  request: async (name: string, options: unknown, callback?: (lock: unknown) => unknown) => {
    const work = (callback ?? options) as (lock: unknown) => unknown;
    if (callback && (options as { ifAvailable?: boolean }).ifAvailable && heldLocks.has(name)) return work(null);
    heldLocks.add(name); try { return await work({ name }); } finally { heldLocks.delete(name); } },
  query: async () => ({ held: [...heldLocks].map(name => ({ name })) }) } } });

export const operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const endpoint = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const generation = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ordinary = { generation, sequence: 1, model: { providerID: 'cliproxyapi', modelID: 'gpt-6-astra', name: 'GPT-6 Astra' }, thinkingLevel: 'medium' };
const cancelled = (value: NativeCreationState) => Response.json({ nativeCreation: { ...value, revision: 0, generation: null, phase: 'cancelled' } });
type Harness = {
  fixture?: ReturnType<typeof nativeDraftFixture>; operation: NativeCreationState; reads: NativeCreationState[];
  reply: (body: NativeCreationReply) => NativeCreationState; abandon: (value: NativeCreationState) => Response; restore: () => void;
  listed: () => NativeCreationState[];
};
export const h: Harness = {
  operation: { operationId, directory, generation: null, revision: 0, phase: 'unavailable', expiresAt: 0, canInitialReady: false },
  reads: [], reply: () => h.operation, abandon: cancelled, restore: () => {}, listed: () => [h.operation],
};
/** The current test's fixture; interactive() sets it. */
export function fx(): ReturnType<typeof nativeDraftFixture> {
  if (!h.fixture) throw new Error('Call interactive() first');
  return h.fixture;
}
export const sentMark = () => localStorage.getItem(`oc.nativeCreation.sent:${JSON.stringify([fx().runtimeA, directory])}`);
export const unavailable = (): NativeCreationState => ({ operationId, directory, generation: null, revision: 0, phase: 'unavailable',
  expiresAt: h.operation.expiresAt, canInitialReady: false, clientRequestId: h.operation.clientRequestId });
export const replies = () => fx().requests.filter(r => new URL(r.url).pathname.endsWith('/reply'));
export const repliedActions = async () => (await Promise.all(replies().map(r => r.clone().json()))).map(body => body.action);
export const record = () => nativeCreationForDraft(useSessionUIStore.getState().nativeDraftCreations,
  useSessionUIStore.getState().newSessionDraft, fx().runtimeA);
export const failure = (promise: Promise<unknown>) => promise.then(() => 'resolved', (error: { code?: string }) => error.code ?? String(error));
export const send = (nativeIntent?: NativeDraftSend) => {
  const input = useInputStore.getState();
  return useSessionUIStore.getState().sendMessage(input.pendingInputText ?? '', ordinary.model.providerID, ordinary.model.modelID,
    undefined, input.attachedFiles, undefined, input.pendingSyntheticParts ?? undefined, undefined, 'normal',
    { draftSnapshot: { ...useSessionUIStore.getState().newSessionDraft }, nativeIntent });
};
/** Send as the composer does: the start's request travels with the Send (its sent mark, #117). */
export async function composerSend(submitted?: string) {
  const draft = useSessionUIStore.getState().newSessionDraft, native = await preparedNativeDraft(draft);
  const intent = native ? await prepareNativeDraftSend(draft, native) : undefined;
  if (intent && submitted !== undefined) noteNativeDraftSubmitted(intent, submitted);
  return send(intent);
}

export function interactive(first: () => NativeCreationState) {
  const fixture = h.fixture = nativeDraftFixture();
  useProjectsStore.setState({ managedCatalogStatus: 'stock' });
  h.operation = { operationId, directory, generation: endpoint, revision: 1, phase: 'awaiting-trust', expiresAt: Date.now() + 60_000, canInitialReady: false };
  fixture.handlers.health = async () => Response.json({ healthy: true, capabilities: { ordinaryInteractiveCreate: 1, creationClientRequestId: 1, creationAbandon: 1 } });
  fixture.handlers.create = async request => {
    const sent = await request.clone().text();
    h.operation = { ...h.operation };
    if (sent) h.operation.clientRequestId = JSON.parse(sent).clientRequestId;
    return Response.json({ nativeCreation: first() }, { status: 202 });
  };
  h.reply = body => {
    h.operation = { ...h.operation, revision: h.operation.revision + 1, phase: body.action === 'trust' ? 'ready-required' : 'ready' };
    if (body.action === 'trust') { h.operation.native = { id: session.id, generation }; h.operation.canInitialReady = true; }
    return h.operation;
  };
  const inner = globalThis.fetch;
  h.restore = () => { globalThis.fetch = inner; };
  // SAFETY: the fixture fetch takes and returns exactly what fetch does; only Bun's extra static members differ.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    if (path.includes('/session/creation') || path.endsWith(`/session/${session.id}`)) {
      fixture.requests.push(request.clone());
      if (path.endsWith('/creation')) return Response.json({ nativeCreations: h.listed() });
      if (path.endsWith('/reply')) return Response.json({ nativeCreation: h.reply(await request.json()) });
      if (path.endsWith('/abandon')) return h.abandon(h.operation);
      if (path.endsWith(`/creation/${operationId}`)) return Response.json({ nativeCreation: h.reads.shift() ?? h.operation });
      return Response.json({ ...session, nativeCreation: undefined, ordinary });
    }
    return inner(input, init);
  }) as typeof fetch;
}

export function resetInteractive() {
  h.restore(); h.restore = () => {}; h.fixture?.dispose(); sessionStorage.clear(); localStorage.clear();
  resetNativeDraftPage(); resetSentStartsForPage(); h.reads = []; h.abandon = cancelled; h.listed = () => [h.operation];
}
