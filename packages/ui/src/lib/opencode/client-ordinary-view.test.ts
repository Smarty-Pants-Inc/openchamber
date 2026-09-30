import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { ChildStoreManager } from '@/sync/child-store';
import { SessionMessageLoader, setImperativeSessionMessageLoader } from '@/sync/session-message-loader';
import { setSyncRefs } from '@/sync/sync-refs';
import { refreshRuntimeUrlAuthToken } from '../runtime-auth';
import { switchRuntimeEndpoint } from '../runtime-switch';
import { deferred } from '../runtime-isolation-fixture';
import { opencodeClient } from './client';
import { reloadPendingSteersForTest, takePendingSteer } from '@/sync/pending-steers';

const originalFetch = globalThis.fetch;
const memory = new Map<string, string>();
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); },
  removeItem: (key: string) => { memory.delete(key); }, clear: () => memory.clear(), key: () => null, length: 0,
} satisfies Storage });
const view = `ov2_${'a'.repeat(64)}`;
const olderView = `ov2_${'b'.repeat(64)}`;
const target = { directory: '/repo', sessionID: 'ordinary-a' };
const params = { directory: target.directory, id: target.sessionID, runtimeKey: 'a',
  providerID: 'ordinary-wire-fixture', modelID: 'test', text: 'hello', messageId: 'msg_client' };
const requests: Request[] = [];
let childStores: ChildStoreManager;
let loader: SessionMessageLoader;
let history: (request: Request) => Promise<Response>;
let prompt: () => Promise<Response>;

const page = (token: string, id = 'tail', cursor?: string): Response => {
  const headers = new Headers({ 'x-smarty-ordinary-view': token });
  if (cursor) headers.set('x-next-cursor', cursor);
  return Response.json([{
    info: { id, sessionID: target.sessionID, role: 'user', time: { created: id === 'tail' ? 2 : 1 } },
    parts: [{ id: `part_${id}`, messageID: id, sessionID: target.sessionID, type: 'text', text: id }],
  }], { headers });
};

const switchTo = async (runtimeKey: string) => {
  switchRuntimeEndpoint({ apiBaseUrl: 'https://ordinary.invalid', runtimeKey, clientToken: `fixture-${runtimeKey}` });
  await refreshRuntimeUrlAuthToken();
  opencodeClient.reconnectToRuntimeBaseUrl();
};
// The page's error report (smarty-code#536) is no prompt.
const prompts = () => requests.filter(request => request.method === 'POST' && !request.url.endsWith('/client-error'));

beforeEach(async () => {
  requests.length = 0;
  memory.clear();
  reloadPendingSteersForTest();
  history = async () => page(view);
  prompt = async () => new Response(null, { status: 204 });
  // Exercise the actual SDK, runtime transport and loader. No endpoint is contacted.
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === '/auth/url-token') {
      return Response.json({ token: 'fixture-url-token', expiresAt: Date.now() + 60_000 });
    }
    requests.push(request);
    if (request.method === 'GET' && path.endsWith('/message')) return history(request);
    if (request.method === 'POST' && path.endsWith('/prompt_async')) return prompt();
    throw new Error(`Unexpected fixture request: ${request.method} ${path}`);
  };
  await switchTo('a');
  opencodeClient.setDirectory('/unrelated');
  childStores = new ChildStoreManager();
  loader = new SessionMessageLoader(childStores, { sdk: opencodeClient.getSdkClient(), runtimeKey: 'a' });
  setImperativeSessionMessageLoader(loader);
});

afterEach(() => {
  setImperativeSessionMessageLoader(null);
  loader.dispose();
  childStores.disposeAll();
  opencodeClient.setDirectory(undefined);
  globalThis.fetch = originalFetch;
});

test('forwards only the materialized tail header through the real SDK, preserving request scope and body', async () => {
  const pending = deferred<Response>();
  history = async request => new URL(request.url).searchParams.has('before')
    ? page(olderView, 'older') : pending.promise;
  const loading = loader.ensure(target);
  expect(loader.getAcceptedOrdinaryView(target, 'a')).toBeUndefined();
  pending.resolve(page(view, 'tail', 'older-cursor'));
  await loading;
  expect(childStores.getChild('/repo')?.getState().message[target.sessionID]?.map(message => message.id)).toEqual(['tail']);
  await loader.loadOlder(target);
  expect(loader.getAcceptedOrdinaryView(target, 'a')).toBe(view);

  expect(await opencodeClient.sendMessage({ ...params, directory: '/repo/' })).toBe('msg_client');
  expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
    ['GET', '/api/session/ordinary-a/message'], ['GET', '/api/session/ordinary-a/message'],
    ['POST', '/api/session/ordinary-a/prompt_async'],
  ]);
  expect(new URL(requests[0].url).searchParams.get('directory')).toBe('/repo');
  expect(new URL(requests[1].url).searchParams.get('before')).toBe('older-cursor');
  const sent = prompts()[0];
  expect(new URL(sent.url).searchParams.get('directory')).toBe('/repo');
  expect(sent.headers.get('x-smarty-ordinary-view')).toBe(view);
  expect(sent.headers.get('authorization')).toBe('Bearer fixture-a');
  expect(await sent.json()).toEqual({ model: { providerID: params.providerID, modelID: params.modelID },
    messageID: 'msg_client', parts: [{ type: 'text', text: 'hello' }] });
  expect(loader.getAcceptedOrdinaryView(target, 'a')).toBeUndefined();
});

// smarty-code#827 (slice 1 on 3.48): a steer right after your own prompt sat for the whole 5 s view refresh (5-7 s under
// load) before its POST left. The gateway accepts an earlier view of the same branch, so it goes at once with the last one.
test('a second send goes at once with the last view of the branch; it never waits for the revoked view\'s re-read', async () => {
  await loader.ensure(target);
  await opencodeClient.sendMessage(params);
  expect(loader.getAcceptedOrdinaryView(target, 'a')).toBeUndefined();
  let reads = 0;
  history = async () => { reads += 1; return new Promise<Response>(() => {}); }; // A re-read that never answers.
  const started = Date.now();
  await opencodeClient.sendMessage({ ...params, messageId: 'msg_second' });
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(reads).toBe(0);
  expect(requests.map(request => request.method)).toEqual(['GET', 'POST', 'POST']);
  expect(prompts().map(request => request.headers.get('x-smarty-ordinary-view'))).toEqual([view, view]);
});

test('after a reset (a changed branch) the last view is gone: the send waits for a fresh read, as before', async () => {
  await loader.ensure(target);
  await opencodeClient.sendMessage(params);
  loader.invalidateOrdinaryView(target, true); // A 409 or a changed branch resets it.
  expect(loader.getSendableOrdinaryView(target, 'a')).toBeUndefined();
  const second = `ov2_${'c'.repeat(64)}`;
  history = async () => page(second);
  await opencodeClient.sendMessage({ ...params, messageId: 'msg_second' });
  expect(requests.map(request => request.method)).toEqual(['GET', 'POST', 'GET', 'POST']);
  expect(prompts().map(request => request.headers.get('x-smarty-ordinary-view'))).toEqual([view, second]);
});

test('never borrows a view from another session, directory or same-URL runtime', async () => {
  await loader.ensure(target);
  await opencodeClient.sendMessage({ ...params, id: 'ordinary-b' });
  await opencodeClient.sendMessage({ ...params, directory: '/other' });
  await switchTo('b');
  await opencodeClient.sendMessage({ ...params, runtimeKey: 'b' });
  expect(prompts()).toHaveLength(3);
  expect(prompts().map(request => request.headers.get('x-smarty-ordinary-view'))).toEqual([null, null, null]);
  expect(prompts().map(request => request.headers.get('authorization')))
    .toEqual(['Bearer fixture-a', 'Bearer fixture-a', 'Bearer fixture-b']);
  expect(loader.getAcceptedOrdinaryView(target, 'a')).toBe(view);
});

test('a failed tail read preserves records but cannot authorize the next prompt', async () => {
  await loader.ensure(target);
  history = async () => Response.json({ message: 'stale branch' }, { status: 409,
    headers: { 'x-smarty-ordinary-view': olderView } });
  await loader.refreshTail(target, 50);
  expect(loader.getSnapshot(target).status).toBe('error');
  expect(loader.getAcceptedOrdinaryView(target, 'a')).toBeUndefined();
  expect(childStores.getChild('/repo')?.getState().message[target.sessionID]?.map(message => message.id)).toEqual(['tail']);
  // F11: a prompt without a view is refused here, visibly, instead of going out bare to a guaranteed 409.
  await expect(opencodeClient.sendMessage(params)).rejects.toThrow('nothing was sent');
  expect(prompts()).toHaveLength(0);
});

test('a session whose record is ordinary loads its history first and sends with that view (F11)', async () => {
  setSyncRefs(opencodeClient.getSdkClient(), childStores, target.directory);
  childStores.ensureChild(target.directory, { bootstrap: false }).setState({ session: [{ id: target.sessionID,
    directory: target.directory, ordinary: { generation: 'g1', sequence: 1, thinkingLevel: 'high',
      model: { providerID: params.providerID, modelID: params.modelID, name: 'Test' } } } as never] });
  expect(loader.isOrdinary(target, 'a')).toBe(false);
  await opencodeClient.sendMessage(params);
  expect(requests.map(request => request.method)).toEqual(['GET', 'POST']);
  expect(prompts()[0].headers.get('x-smarty-ordinary-view')).toBe(view);
});

test('a refusal shows the server\'s own words, not the raw body (F11)', async () => {
  await loader.ensure(target);
  const reason = 'The page was out of date, so nothing was sent. Your message is still here.';
  prompt = async () => Response.json({ name: 'APIError', data: { message: reason, isRetryable: false } }, { status: 409 });
  const error = await opencodeClient.sendMessage(params).catch((caught: unknown) => caught);
  expect(error instanceof Error ? error.message : String(error)).toBe(reason);
  expect((error as Error & { status?: number }).status).toBe(409);
});

// openchamber#375 review 4 (P2 3): a re-send that reuses a pending or delivered message's client ID is refused as a
// reservation conflict. That is no changed branch: the last view stays sendable and nothing is re-read.
test('a client-ID reservation conflict on a re-send keeps the last view and reads nothing again', async () => {
  await loader.ensure(target);
  prompt = async () => Response.json({ name: 'APIError', data: { message: 'Client message ID already exists or a submission is pending',
    isRetryable: false } }, { status: 409 });
  // Its own provider: this refusal must not count toward the other tests' provider circuit.
  await expect(opencodeClient.sendMessage({ ...params, providerID: 'conflict-fixture' })).rejects.toThrow('Client message ID already exists');
  expect(loader.getSendableOrdinaryView(target, 'a')).toBe(view);
  expect(requests.map(request => request.method)).toEqual(['GET', 'POST']);
});

test('an unconfirmed send (503) shows the server\'s words and keeps its status for the unconfirmed path (F11)', async () => {
  await loader.ensure(target);
  const reason = 'The server could not confirm this message. Check the chat before sending it again.';
  prompt = async () => Response.json({ name: 'APIError', data: { message: reason, isRetryable: false } }, { status: 503 });
  const error = await opencodeClient.sendMessage(params).catch((caught: unknown) => caught);
  expect(error instanceof Error ? error.message : String(error)).toBe(reason);
  expect((error as Error & { status?: number }).status).toBe(503);
  expect(prompts()).toHaveLength(1);
});

test('a reset of the branch view during attachment preparation prevents POST dispatch', async () => {
  await loader.ensure(target);
  const sending = opencodeClient.sendMessage({ ...params,
    files: [{ type: 'file', mime: 'text/markdown', filename: 'notes.md', url: 'data:text/markdown,hello' }] });
  loader.invalidateOrdinaryView(target, true); // A 409 or a changed branch.
  await expect(sending).rejects.toThrow('view changed before submission');
  expect(prompts()).toHaveLength(0);
});

// smarty-code#827: under load the event stream stalls and reconnects; that reset every view, and the next send sat for
// the whole 5 s re-read and was then refused ("history has not finished loading"). A reconnect is no changed branch:
// the send goes with the last view (the gateway still refuses one its branch moved past, 409, re-read and resent once).
test('a lost event stream during a send keeps the last view: the POST goes, with it, without waiting for a re-read', async () => {
  await loader.ensure(target);
  let reads = 0;
  history = async () => { reads += 1; return new Promise<Response>(() => {}); };
  const sending = opencodeClient.sendMessage({ ...params,
    files: [{ type: 'file', mime: 'text/markdown', filename: 'notes.md', url: 'data:text/markdown,hello' }] });
  loader.invalidateOrdinaryViews(); // onDisconnect / onTransportSwitch
  await sending;
  expect(reads).toBe(0);
  expect(prompts().map(request => request.headers.get('x-smarty-ordinary-view'))).toEqual([view]);
});

test('a transport failure revokes the submitted view without inventing an HTTP status or replaying', async () => {
  await loader.ensure(target);
  prompt = async () => { throw new TypeError('fixture connection lost'); };
  await expect(opencodeClient.sendMessage(params)).rejects.toThrow('Message send transport failure: fixture connection lost');
  expect(prompts()).toHaveLength(1);
  expect(prompts()[0].headers.get('x-smarty-ordinary-view')).toBe(view);
  expect(loader.getAcceptedOrdinaryView(target, 'a')).toBeUndefined();
  expect(requests).toHaveLength(2);
});

// Co-steer (MVP 1 G5): the gateway says how it took the prompt, and a stale view is re-read and resent once.
const staleRefusal = () => Response.json({ name: 'APIError', data: { message: 'The session changed since this page read it.',
  isRetryable: false, code: 'smarty.prompt-stale-view' } }, { status: 409 });

// The notice loads its module after the send resolves (76d95ca62). A cold load takes tens of ms, so a fixed timer
// raced it (smarty-code#1034): wait for the same load the client waits on, then its continuation.
const noticeSettled = async () => { await import('./promptDelivery'); await new Promise(resolve => setTimeout(resolve, 0)); };

test('a steered prompt is announced as delivered while the agent works; a new turn is not (G5)', async () => {
  const { toast } = await import('@/components/ui');
  const seen: string[] = [];
  const spy = spyOn(toast, 'success').mockImplementation(message => { seen.push(String(message)); return 'toast'; });
  try {
    await loader.ensure(target);
    prompt = async () => new Response(null, { status: 204, headers: { 'x-smarty-prompt-delivery': 'steer' } });
    await opencodeClient.sendMessage(params);
    history = async () => page(`ov2_${'d'.repeat(64)}`);
    prompt = async () => new Response(null, { status: 204, headers: { 'x-smarty-prompt-delivery': 'prompt' } });
    await opencodeClient.sendMessage({ ...params, messageId: 'msg_second' });
    history = async () => page(`ov2_${'9'.repeat(64)}`);
    prompt = async () => new Response(null, { status: 204 });
    await opencodeClient.sendMessage({ ...params, messageId: 'msg_third' });
    await noticeSettled(); // The notice follows the accepted send, never gates it.
    expect(seen).toEqual(['Delivered while the agent works.']);
  } finally { spy.mockRestore(); }
});

test('a stale-view refusal re-reads the session and sends the same message once more with the fresh view (G5)', async () => {
  await loader.ensure(target);
  const fresh = `ov2_${'e'.repeat(64)}`;
  let posts = 0;
  prompt = async () => (++posts === 1 ? staleRefusal() : new Response(null, { status: 204 }));
  history = async () => page(fresh);
  expect(await opencodeClient.sendMessage(params)).toBe('msg_client');
  expect(prompts().map(request => request.headers.get('x-smarty-ordinary-view'))).toEqual([view, fresh]);
  const bodies = await Promise.all(prompts().map(request => request.json()));
  expect(bodies.map(body => body.messageID)).toEqual(['msg_client', 'msg_client']);
  expect(bodies[1]).toEqual(bodies[0]);
});

test('a second stale-view refusal is shown, never a third POST (G5)', async () => {
  await loader.ensure(target);
  prompt = async () => staleRefusal();
  history = async () => page(`ov2_${'f'.repeat(64)}`);
  const error = await opencodeClient.sendMessage(params).catch((caught: unknown) => caught);
  expect((error as Error & { status?: number }).status).toBe(409);
  expect(prompts()).toHaveLength(2);
});

test('only a stale view is resent: busy, blocked and a stale view the re-read cannot change are not (G5)', async () => {
  await loader.ensure(target);
  for (const code of ['smarty.prompt-busy', 'smarty.prompt-blocked']) {
    requests.length = 0;
    history = async () => page(view);
    await loader.refreshOrdinaryView(target);
    prompt = async () => Response.json({ name: 'APIError', data: { message: code, isRetryable: false, code } }, { status: 409 });
    await opencodeClient.sendMessage(params).catch(() => undefined);
    expect(prompts()).toHaveLength(1);
  }
  requests.length = 0;
  history = async () => page(view);
  await loader.refreshOrdinaryView(target);
  prompt = async () => staleRefusal();
  await opencodeClient.sendMessage(params).catch(() => undefined);
  expect(prompts()).toHaveLength(1);
});

test('only a queued steer keeps a record for its later outcome; a started turn or a refusal is settled at once (G5)', async () => {
  await loader.ensure(target);
  const kept = (messageID: string) => takePendingSteer('a', target.sessionID, messageID);
  let reads = 0; // Each send revokes the view; the next one reads a fresh one.
  const again = () => { reads += 1; history = async () => page(`ov2_${String(reads).padStart(64, '0')}`); };
  prompt = async () => new Response(null, { status: 204, headers: { 'x-smarty-prompt-delivery': 'steer' } });
  await opencodeClient.sendMessage({ ...params, messageId: 'msg_steer', text: 'steer me' });
  again();
  prompt = async () => new Response(null, { status: 204, headers: { 'x-smarty-prompt-delivery': 'prompt' } });
  await opencodeClient.sendMessage({ ...params, messageId: 'msg_turn' });
  again();
  prompt = async () => Response.json({ name: 'APIError', data: { message: 'blocked', isRetryable: false, code: 'smarty.prompt-blocked' } }, { status: 409 });
  await opencodeClient.sendMessage({ ...params, messageId: 'msg_refused' }).catch(() => undefined);
  again();
  prompt = async () => { throw new TypeError('fixture connection lost'); };
  await opencodeClient.sendMessage({ ...params, messageId: 'msg_unknown' }).catch(() => undefined);
  expect(kept('msg_steer')?.text).toBe('steer me');
  expect(kept('msg_turn')).toBeUndefined();
  // A send the owner has not answered yet (smarty-code#399): 204 with a queued receipt; its outcome follows as an event.
  again();
  prompt = async () => new Response(null, { status: 204, headers: { 'x-smarty-prompt-receipt': 'queued' } });
  await opencodeClient.sendMessage({ ...params, messageId: 'msg_receipt' });
  expect(kept('msg_receipt')?.messageID).toBe('msg_receipt');
  expect(kept('msg_refused')).toBeUndefined();
  expect(kept('msg_unknown')?.messageID).toBe('msg_unknown');
  // The proxy's 503 and 504 can follow a POST the gateway accepted: the outcome is unknown, so the record stays.
  for (const status of [503, 504, 408]) {
    // A started turn between failures keeps the provider circuit closed (it opens after three errors in a row).
    again();
    prompt = async () => new Response(null, { status: 204, headers: { 'x-smarty-prompt-delivery': 'prompt' } });
    await opencodeClient.sendMessage({ ...params, messageId: `msg_ok_${status}` });
    again();
    prompt = async () => new Response('upstream', { status });
    await opencodeClient.sendMessage({ ...params, messageId: `msg_${status}` }).catch(() => undefined);
    expect(kept(`msg_${status}`)?.messageID).toBe(`msg_${status}`);
  }
  again();
  prompt = async () => new Response(null, { status: 204, headers: { 'x-smarty-prompt-delivery': 'prompt' } });
  await opencodeClient.sendMessage({ ...params, messageId: 'msg_ok_last' });
});

test('a refused send that reuses a queued steer\'s message ID leaves the queued record in place (G5)', async () => {
  await loader.ensure(target);
  prompt = async () => new Response(null, { status: 204, headers: { 'x-smarty-prompt-delivery': 'steer' } });
  await opencodeClient.sendMessage({ ...params, messageId: 'msg_shared', text: 'queued first' });
  history = async () => page(`ov2_${'7'.repeat(64)}`);
  prompt = async () => Response.json({ name: 'APIError', data: { message: 'blocked', isRetryable: false, code: 'smarty.prompt-blocked' } }, { status: 409 });
  await opencodeClient.sendMessage({ ...params, messageId: 'msg_shared', text: 'refused second' }).catch(() => undefined);
  expect(takePendingSteer('a', target.sessionID, 'msg_shared')?.text).toBe('queued first');
});

test('an outcome that beats the 204 is not contradicted by a "delivered while it works" notice (G5)', async () => {
  const { toast } = await import('@/components/ui');
  const seen: string[] = [];
  const spy = spyOn(toast, 'success').mockImplementation(message => { seen.push(String(message)); return 'toast'; });
  try {
    await loader.ensure(target);
    prompt = async () => {
      // The run ended without it, and the outcome settled its record before the POST answered.
      takePendingSteer('a', target.sessionID, 'msg_early');
      return new Response(null, { status: 204, headers: { 'x-smarty-prompt-delivery': 'steer' } });
    };
    expect(await opencodeClient.sendMessage({ ...params, messageId: 'msg_early' })).toBe('msg_early');
    await noticeSettled();
    expect(seen).toHaveLength(0);
  } finally { spy.mockRestore(); }
});

// Paul's everyday path (slice 1 step 6 follow-up): in an existing session, Send right after its idle, while that idle's
// tail refresh is still reading. The message goes once, at once, with the kept view; a view the session moved past
// meanwhile is refused by the gateway, re-read and resent once: never lost, never doubled.
test('a Send right after idle, while the tail refresh reads, goes once with the kept view', async () => {
  await loader.ensure(target);
  const gate = deferred<void>();
  history = async () => { await gate.promise; return page(view); };
  const refresh = loader.refreshOrdinaryView(target); // The idle's refresh: held.
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(await opencodeClient.sendMessage(params)).toBe('msg_client');
  expect(prompts()).toHaveLength(1);
  expect(prompts()[0]!.headers.get('x-smarty-ordinary-view')).toBe(view);
  gate.resolve(); await refresh;
});

test('a Send with the kept view after the session moved on is refused by the gateway, re-read and resent once', async () => {
  await loader.ensure(target);
  const gate = deferred<void>(), fresh = `ov2_${'c'.repeat(64)}`;
  let reads = 0;
  history = async () => { if (++reads === 1) await gate.promise; return page(fresh); };
  const refresh = loader.refreshOrdinaryView(target); // Held: the page still holds the older view.
  await new Promise(resolve => setTimeout(resolve, 5));
  let posts = 0;
  prompt = async () => (++posts === 1 ? staleRefusal() : new Response(null, { status: 204 }));
  const sending = opencodeClient.sendMessage(params);
  await new Promise(resolve => setTimeout(resolve, 20));
  gate.resolve();
  expect(await sending).toBe('msg_client');
  await refresh;
  expect(prompts().map(request => request.headers.get('x-smarty-ordinary-view'))).toEqual([view, fresh]);
  const bodies = await Promise.all(prompts().map(request => request.json()));
  expect(bodies.map(body => body.messageID)).toEqual(['msg_client', 'msg_client']); // The same message, never a second one.
});

// smarty-code#827: while an agent works, each removed live row resets the view (message.removed); a steer then found no
// view and waited the whole 5 s re-read. The reset re-reads history, but the last view stays sendable.
test('an event reset (a removed live row) keeps the last view sendable: a steer goes at once', async () => {
  await loader.ensure(target);
  let reads = 0;
  history = async () => { reads += 1; return new Promise<Response>(() => {}); };
  void loader.refreshOrdinaryView(target, true);
  expect(loader.getAcceptedOrdinaryView(target, 'a')).toBeUndefined();
  const started = Date.now();
  await opencodeClient.sendMessage({ ...params, messageId: 'msg_steer' });
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(prompts().map(request => request.headers.get('x-smarty-ordinary-view'))).toEqual([view]);
  expect(reads).toBe(1); // The reset's own re-read, not one the send waited for.
});
