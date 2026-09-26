import { afterEach, expect, spyOn, test } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { act } from 'react';
import type { NativeCreationState } from '@/lib/opencode/nativeCreation';
import { mountedNativeComposer } from './nativeComposer.fixture';
import { session, directory } from '@/sync/native-draft-fixture';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { resetNativeDraftPage } from '@/sync/native-draft-start';
import { resetSentStartsForPage } from '@/sync/native-draft-sent';
import { writeChatDraft } from '@/lib/chatDraftPersistence';

// smarty-dev#856 (Release 3.34, slice 1, Kate's step 6): a first-ever New session → Send created its session, which
// settled ready, but its first message was never sent: a catalog sample that briefly lacked the project (the fleet was
// changing) failed the send-side project check with 'target' after the session existed. The text stayed in the draft
// with only a passing toast.
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
  const state = { onReady: () => {}, operation: undefined as NativeCreationState | undefined, list: () => (state.operation ? [state.operation] : []) as NativeCreationState[] };
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
        if (body.action !== 'trust') state.onReady();
        return Response.json({ nativeCreation: state.operation });
      }
      if (/\/creation\/[^/]+$/.test(path)) return Response.json({ nativeCreation: state.operation });
      return Response.json({ ...session, nativeCreation: undefined, ordinary });
    }
    return inner(input, init);
  }) as typeof fetch;
  return state;
}


/** A managed catalog with this project, and a New session draft in it (the shown draft). */
const managed = async () => {
  const rowA = { worktree: directory, name: 'a' }, rowB = { worktree: '/native-project-b', name: 'b' };
  await act(async () => { useProjectsStore.getState().applyManagedCatalog([rowA, rowB] as never); });
  await act(async () => { useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: 'a', directoryOverride: directory }); });
  await settle();
  return { rowA, rowB };
};
/** The saved new-session draft of this project (any generation). */
const slot = () => {
  const envelope = JSON.parse(localStorage.getItem('openchamber.chatDrafts.v2') ?? '{"drafts":{}}') as { drafts: Record<string, { text: string }> };
  return Object.entries(envelope.drafts).find(([key]) => key.includes(directory) && key.endsWith('null]'))?.[1]?.text ?? '';
};

test('the person opens her new session from the sidebar while its first message is still being sent: it is sent once', async () => {
  let server!: ReturnType<typeof interactiveServer>;
  const c = mounted = await mountedNativeComposer(false, undefined, undefined, undefined, fixture => { server = interactiveServer(fixture); });
  await managed();
  // Its row appears as soon as the session starts; she clicks it right when it turns ready (Release 3.34, Kate's step 6).
  server.onReady = () => { void useSessionUIStore.getState().setCurrentSession(session.id, directory); };
  await c.replace('First message'); await c.submit();
  for (let i = 0; i < 40 && c.prompts().length < 1; i++) await settle();
  expect(c.creates()).toHaveLength(1);
  expect(c.prompts()).toHaveLength(1); // Sent once, to the session it started.
  const body = await c.prompts()[0]!.json() as { parts: Array<{ type: string; text?: string }> };
  expect(body.parts.some(part => part.type === 'text' && part.text === 'First message')).toBe(true);
  expect(useSessionUIStore.getState().currentSessionId).toBe(session.id); // Her session is open...
  expect(slot()).toBe(''); // ...and the draft no longer holds the sent text.
  expect(c.dom.container.querySelector('[role="alert"]')).toBeNull();
});

test('a first message the page cannot send after its session started says why, keeps the text, and Send sends it once', async () => {
  let server!: ReturnType<typeof interactiveServer>;
  const c = mounted = await mountedNativeComposer(false, undefined, undefined, undefined, fixture => { server = interactiveServer(fixture); });
  await managed();
  // The sent mark (#117) cannot be stored the first time, so the page must not send (a storage refusal after the start).
  let refuse = true;
  const proto = Object.getPrototypeOf(localStorage) as Storage;
  const setItem = proto.setItem;
  const refusing = spyOn(proto, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (refuse && key.startsWith('oc.nativeCreation.sent:')) throw new DOMException('full', 'QuotaExceededError');
    return setItem.call(this, key, value);
  });
  await c.replace('Keep this'); await c.submit();
  for (let i = 0; i < 20; i++) await settle();
  expect(c.creates()).toHaveLength(1); expect(c.prompts()).toHaveLength(0);
  expect(c.text()).toBe('Keep this');
  expect(c.dom.container.querySelector('[role="alert"]')?.textContent ?? '').toContain('Your message is still here'); // Says why, and stays.
  refuse = false; // Storage works again.
  await c.submit(); // Send again: to the session that already started.
  for (let i = 0; i < 40 && c.prompts().length < 1; i++) await settle();
  expect(c.creates()).toHaveLength(1); expect(c.prompts()).toHaveLength(1);
  refusing.mockRestore();
  void server;
});

test('a second Send press while the first is fetching its session knowledge, then opening the new session: the first message is still sent once', async () => {
  let server!: ReturnType<typeof interactiveServer>;
  const c = mounted = await mountedNativeComposer(false, undefined, undefined, undefined, fixture => { server = interactiveServer(fixture); });
  await managed();
  // The session's knowledge is slow to load, so the first Send is under way but has not posted its message.
  let release = () => {}; const held = new Promise<void>(resolve => { release = resolve; });
  const served = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(new Request(input, init).url).pathname === '/api/session-knowledge') await held;
    return served(input, init);
  }) as typeof fetch;
  await c.replace('Only once'); await c.submit();
  for (let i = 0; i < 10; i++) await settle();
  expect(c.prompts()).toHaveLength(0); // Still under way.
  await c.submit(); for (let i = 0; i < 3; i++) await settle(); // She presses Send again (refused as a duplicate)...
  await act(async () => { useSessionUIStore.getState().setCurrentSession(session.id, directory); }); // ...and opens its row.
  release();
  for (let i = 0; i < 40 && c.prompts().length < 1; i++) await settle();
  for (let i = 0; i < 5; i++) await settle();
  expect(c.creates()).toHaveLength(1);
  expect(c.prompts()).toHaveLength(1); // The duplicate press never ends the first Send's hold.
  expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
  globalThis.fetch = served; void server;
});

test('a Send that stops after the start without sending (a mentioned file cannot be read) says why and lets her open the session', async () => {
  let server!: ReturnType<typeof interactiveServer>;
  const c = mounted = await mountedNativeComposer(false, undefined, undefined, undefined, fixture => { server = interactiveServer(fixture); });
  await managed();
  const served = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => new URL(new Request(input, init).url).pathname.endsWith('/api/fs/raw')
    ? new Response('gone', { status: 404 }) : served(input, init)) as typeof fetch;
  await c.replace('Read this '); await c.mention('broken.docx'); const kept = c.text();
  await c.submit();
  for (let i = 0; i < 20; i++) await settle();
  expect(c.creates()).toHaveLength(1); expect(c.prompts()).toHaveLength(0);
  expect(c.text()).toBe(kept);
  expect(c.dom.container.querySelector('[role="alert"]')?.textContent ?? '').toContain('broken.docx'); // Says why, and stays.
  // Counterexample: the Send is over, so her session opens at once (no hold left behind).
  await act(async () => { useSessionUIStore.getState().setCurrentSession(session.id, directory); });
  expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
  globalThis.fetch = served; void server;
});

test('a second press that stops early (an unreadable file) while the first Send is under way never releases the first', async () => {
  let server!: ReturnType<typeof interactiveServer>;
  const c = mounted = await mountedNativeComposer(false, undefined, undefined, undefined, fixture => { server = interactiveServer(fixture); });
  await managed();
  let release = () => {}; const held = new Promise<void>(resolve => { release = resolve; });
  const served = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(new Request(input, init).url).pathname;
    if (path === '/api/session-knowledge') await held;
    if (path.endsWith('/api/fs/raw')) return new Response('gone', { status: 404 });
    return served(input, init);
  }) as typeof fetch;
  await c.replace('First'); await c.submit();
  for (let i = 0; i < 10; i++) await settle();
  expect(c.prompts()).toHaveLength(0); // The first Send is under way.
  await c.replace('Second '); await c.mention('broken.docx'); await c.submit(); // Stops: the file cannot be read.
  for (let i = 0; i < 10; i++) await settle();
  await act(async () => { useSessionUIStore.getState().setCurrentSession(session.id, directory); }); // She opens its row.
  release();
  for (let i = 0; i < 40 && c.prompts().length < 1; i++) await settle();
  expect(c.creates()).toHaveLength(1);
  expect(c.prompts()).toHaveLength(1); // The first message is still sent.
  expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
  globalThis.fetch = served; void server;
});

test('a first message the gateway refuses after the start keeps the gateway\'s own reason on screen, with the text', async () => {
  let server!: ReturnType<typeof interactiveServer>;
  const c = mounted = await mountedNativeComposer(false, undefined, undefined, undefined, fixture => {
    server = interactiveServer(fixture);
    fixture.handlers.prompt = async () => Response.json({ name: 'UnknownError', data: { message: 'Finish original Pi dialogs and /code-ready first.' } }, { status: 409 });
  });
  await managed();
  await c.replace('Refused text'); await c.submit();
  for (let i = 0; i < 40 && c.prompts().length < 1; i++) await settle();
  for (let i = 0; i < 10; i++) await settle();
  expect(c.creates()).toHaveLength(1); expect(c.prompts()).toHaveLength(1);
  expect(c.text()).toBe('Refused text');
  // Its own words stay (not "It is not clear whether the session started": it did start).
  expect(c.dom.container.querySelector('[role="alert"]')?.textContent ?? '').toContain('Finish original Pi dialogs and /code-ready first.');
  void server;
});

// #117 on 3.36 (code-controls, #114): a start whose tab was closed while it started, then expired. On the next page,
// after the server stopped listing the settled start (5 min), "check again" said it had not finished starting and the
// text stayed locked. The page's mark keeps its start's operation, so the next page reads it: expired.
test('a start whose tab closed while starting, then expired: the next page gives the text back and says why', async () => {
  let server!: ReturnType<typeof interactiveServer>;
  const c = mounted = await mountedNativeComposer(true, undefined, undefined, undefined, fixture => { server = interactiveServer(fixture); });
  await managed();
  const served = globalThis.fetch;
  let closed = false;
  // The start stays at its trust step until the tab closes; afterwards it expired, and the server no longer lists it
  // (a settled start leaves the listing after 5 min), while a read of the operation still says so.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(new Request(input, init).url).pathname;
    if (!closed) return path.endsWith('/reply') ? new Promise<Response>(() => {}) : served(input, init);
    if (path.endsWith('/session/creation')) return Response.json({ nativeCreations: [] });
    if (path.endsWith(`/session/creation/${operationId}`)) return Response.json({ nativeCreation: { ...server.operation!, phase: 'expired' } });
    return served(input, init);
  }) as typeof fetch;
  await c.replace('Closed tab text'); await c.submit();
  for (let i = 0; i < 10; i++) await settle();
  const sentKey = `oc.nativeCreation.sent:${JSON.stringify([c.runtimeA, directory])}`;
  expect(JSON.parse(localStorage.getItem(sentKey)!).operationId).toBe(operationId); // The page's mark knows its start.
  // The tab closes (its locks and Send attempt end; the mark and the draft it saved stay), and the page loads again.
  closed = true;
  // A new tab has its own session storage: the closed tab's own request id went with it.
  await act(async () => {
    sessionStorage.clear(); resetNativeDraftPage(); resetSentStartsForPage();
    useSessionUIStore.setState({ nativeDraftCreations: new Map() }); // A new page has none of the closed one's memory.
  });
  writeChatDraft({ runtimeKey: c.runtimeA, directory, sessionId: null }, 'Closed tab text', []);
  await act(async () => { c.remount(); });
  for (let i = 0; i < 20; i++) await settle();
  expect(c.dom.container.querySelector('[role="alert"]')?.textContent ?? '').toContain('its session start expired'); // Why.
  expect(c.text()).toBe('Closed tab text'); // The text is back...
  expect(localStorage.getItem(sentKey)).toBeNull(); // ...and no longer locked as sent.
  globalThis.fetch = served;
});
