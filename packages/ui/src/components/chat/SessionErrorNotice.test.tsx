import React, { act } from 'react';
import { Window } from 'happy-dom';
import { expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import type { AssistantMessage, Session, UserMessage } from '@opencode-ai/sdk/v2';
import { SyncProvider, useDirectoryStore, useSessionMessageLoader, useSessionMessageRecords } from '@/sync/sync-context';
import type { ChatMessageEntry } from './lib/turns/types';
import { flattenAssistantTextParts } from '@/lib/messages/messageText';
import { I18nProvider } from '@/lib/i18n';
import { useNotificationStore } from '@/sync/notification-store';
import { SessionErrorNotice } from './SessionErrorNotice';
import { opencodeClient } from '@/lib/opencode/client';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { useConfigStore } from '@/stores/useConfigStore';
import { ChildStoreManager } from '@/sync/child-store';
import { SessionMessageLoader, setImperativeSessionMessageLoader } from '@/sync/session-message-loader';
import { optimisticSend, setActionRefs, setOptimisticRefs } from '@/sync/session-actions';
import { takePendingSteer } from '@/sync/pending-steers';

// smarty-code#1108: a send the server refused before taking it is titled "not sent"; a reply the session stopped keeps
// "stopped this reply". The body is the server's own words in both.
const render = async (sessionId: string, history?: ChatMessageEntry[], ownerGone = true) => {
  const win = new Window({ url: 'http://localhost' });
  const values = { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const container = document.createElement('div');
  const root = createRoot(container);
  let loadHistory: (() => Promise<void>) | undefined;
  const ReloadedReply = () => {
    const loader = useSessionMessageLoader();
    const store = useDirectoryStore('/fixture', { bootstrap: false });
    const records = useSessionMessageRecords(sessionId, '/fixture');
    loadHistory = async () => {
      await loader.ensure({ sessionID: sessionId, directory: '/fixture' });
      const session: Session & { ordinaryCodeMade?: boolean } = { id: sessionId, slug: sessionId, projectID: 'fixture', directory: '/fixture',
        title: 'Reloaded session', version: '1', time: { created: 1, updated: 2 } };
      if (ownerGone) session.ordinaryCodeMade = true;
      store.setState({ session: [session], session_status: { [sessionId]: { type: ownerGone ? 'idle' : 'busy' } } });
    };
    // Exercise the chat's loaded record/text projection without the Vite-only Markdown worker.
    return records.filter(record => record.info.role === 'assistant').map(record => (
      <p key={record.info.id}>{flattenAssistantTextParts(record.parts)}</p>
    ));
  };
  try {
    await act(async () => root.render(
      <SyncProvider directory="/fixture" sdk={createOpencodeClient({ baseUrl: 'http://opencode.test', fetch: async input => {
        const request = input instanceof Request ? input : new Request(input);
        return Response.json(new URL(request.url).pathname.endsWith('/message') ? history ?? [] : [],
          { headers: history && ownerGone ? { 'x-smarty-read-only': '1' } : {} });
      } })}>
        <I18nProvider>
          {history ? <ReloadedReply /> : null}
          <SessionErrorNotice sessionId={sessionId} directory="/fixture" />
        </I18nProvider>
      </SyncProvider>));
    if (history) {
      expect(loadHistory).toBeDefined();
      await act(async () => { await loadHistory?.(); });
    }
    return container.textContent ?? '';
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    await win.happyDOM.close();
  }
};

// smarty-code#1331: a fresh page has loaded history, but no in-flight prompt or session.error event.
const loadedTurn = (sessionID: string, replyCreated?: number, completed?: number): ChatMessageEntry[] => {
  const created = Date.now() - 20_000;
  const user: UserMessage = { id: 'z-ask', sessionID, role: 'user', time: { created }, agent: 'build', model: { providerID: 'p', modelID: 'm' } };
  if (replyCreated === undefined) return [{ info: user, parts: [] }];
  const assistant: AssistantMessage = { id: 'a-reply', sessionID, role: 'assistant', parentID: user.id,
    time: { created: created + replyCreated },
    modelID: 'm', providerID: 'p', mode: 'build', agent: 'build', path: { cwd: '/fixture', root: '/fixture' }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
  if (completed !== undefined) assistant.time.completed = created + completed;
  return [{ info: user, parts: [] }, { info: assistant, parts: [{ id: 'partial', sessionID, messageID: assistant.id, type: 'text', text: 'I started checking the files.' }] }];
};

for (const replyCreated of [1_000, 0]) {
  test(`reload after the owner is gone keeps partial text and says the reply stopped (reply offset ${replyCreated})`, async () => {
    const sessionID = `s-partial-${replyCreated}`;
    const text = await render(sessionID, loadedTurn(sessionID, replyCreated));
    expect(text).toContain('I started checking the files.');
    expect(text).toContain('stopped this reply');
    expect(text).not.toContain('did not start a reply');
  });
}

test('reload after the owner is gone with no reply keeps did-not-start wording', async () => {
  const text = await render('s-no-reply', loadedTurn('s-no-reply'));
  expect(text).toContain('did not start a reply');
  expect(text).not.toContain('stopped this reply');
});

test('an older answer does not count as a reply to the newest unanswered user message', async () => {
  const history = loadedTurn('s-new-ask', 1_000, 2_000);
  const user: UserMessage = { id: 'next-ask', sessionID: 's-new-ask', role: 'user', time: { created: Date.now() - 10_000 },
    agent: 'build', model: { providerID: 'p', modelID: 'm' } };
  const text = await render('s-new-ask', [...history, { info: user, parts: [] }]);
  expect(text).toContain('did not start a reply');
  expect(text).not.toContain('stopped this reply');
});

test('an owner gone after a completed reply does not make that reply stopped', async () => {
  const text = await render('s-finished', loadedTurn('s-finished', 1_000, 2_000));
  expect(text).toContain('I started checking the files.');
  expect(text).not.toContain('stopped this reply');
  expect(text).not.toContain('did not start a reply');
});

test('a busy session with an unfinished reply is not reported as stopped', async () => {
  const text = await render('s-busy', loadedTurn('s-busy', 1_000), false);
  expect(text).toContain('I started checking the files.');
  expect(text).not.toContain('stopped this reply');
  expect(text).not.toContain('did not start a reply');
});

const BLOCKED = "The session's terminal is busy (a dialog, typed text or another message is waiting there). Nothing was sent; finish in the terminal, then send it again.";

test('a refused send is titled "not sent", never "stopped this reply"', async () => {
  useNotificationStore.getState().append({ type: 'error', session: 's-refused', directory: '/fixture', time: Date.now(), viewed: true,
    sendOutcome: 'refused', error: { name: null, message: BLOCKED } });
  const text = await render('s-refused');
  expect(text).toContain('This message was not sent');
  expect(text).not.toContain('stopped this reply');
  expect(text).toContain(BLOCKED);
});

const UNCONFIRMED = 'Code could not confirm that the session received this message. Check the session before sending it again; it is not sent again automatically.';

// Start with an accepted ordinary view, then carry the actual SDK error through
// optimisticSend and into the rendered notice. Confirmation reads never replay a POST.
const sendAndRender = async (sessionID: string, status: 409 | 503, confirmation: 'failed' | 'empty') => {
  const originalFetch = globalThis.fetch;
  const requests: Request[] = [];
  const directory = '/fixture';
  const runtimeKey = `notice-${sessionID}`;
  const target = { directory, sessionID };
  const view = `ov2_${'a'.repeat(64)}`;
  const reason = status === 503 ? UNCONFIRMED : BLOCKED;
  const children = new ChildStoreManager();
  let dispatched = false;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === '/auth/url-token') return Response.json({ token: 'fixture-url-token', expiresAt: Date.now() + 60_000 });
    requests.push(request);
    if (request.method === 'POST' && path.endsWith('/prompt_async')) {
      dispatched = true;
      const data = { message: reason, isRetryable: false, code: status === 409 ? 'smarty.prompt-blocked' : undefined };
      return Response.json({ name: 'APIError', data }, { status });
    }
    if (request.method === 'GET' && path.endsWith('/message')) {
      if (dispatched && status === 503) return confirmation === 'failed'
        ? Response.json({ name: 'APIError', data: { message: 'History unavailable' } }, { status: 503 })
        : Response.json([]);
      return Response.json([], { headers: { 'x-smarty-ordinary-view': view } });
    }
    throw new Error(`Unexpected fixture request: ${request.method} ${path}`);
  };
  let loader: SessionMessageLoader | undefined;
  try {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://notice.invalid', runtimeKey });
    await refreshRuntimeUrlAuthToken();
    opencodeClient.reconnectToRuntimeBaseUrl();
    const sdk = opencodeClient.getSdkClient();
    loader = new SessionMessageLoader(children, { sdk, runtimeKey });
    const messageLoader = loader;
    setImperativeSessionMessageLoader(loader);
    setActionRefs(sdk, children, () => directory);
    setOptimisticRefs(
      input => messageLoader.optimisticAdd({ ...input, directory }),
      input => messageLoader.optimisticRemove({ ...input, directory }),
      input => messageLoader.optimisticConfirm({ ...input, directory }),
    );
    useConfigStore.setState({ isConnected: true });
    await loader.ensure(target);
    expect(loader.getAcceptedOrdinaryView(target, runtimeKey)).toBe(view);
    const messageID = `msg_${sessionID}`;
    await expect(optimisticSend({ runtimeKey, sessionId: sessionID, directory, messageID,
      content: 'hello', providerID: runtimeKey, modelID: 'fixture',
      send: async id => { await opencodeClient.sendMessage({ runtimeKey, id: sessionID, directory,
        messageId: id, text: 'hello', providerID: runtimeKey, modelID: 'fixture' }); },
    })).rejects.toThrow(reason);
    // A 409 resets and refreshes the ordinary view in the client. Drain that read before cleanup.
    if (status === 409) await loader.refreshOrdinaryView(target);
    const posts = requests.filter(request => request.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].headers.get('x-smarty-ordinary-view')).toBe(view);
    expect(await posts[0].json()).toMatchObject({ messageID, parts: [{ type: 'text', text: 'hello' }] });
    const confirmationReads = requests.filter(request => request.method === 'GET'
      && new URL(request.url).searchParams.get('limit') === '30');
    expect(confirmationReads).toHaveLength(status === 503 ? 3 : 0);
    for (const request of confirmationReads) {
      expect(new URL(request.url).pathname).toBe(`/api/session/${sessionID}/message`);
      expect(new URL(request.url).searchParams.get('directory')).toBe(directory);
    }
    expect(children.getChild(directory)?.getState().message[sessionID]).toEqual([]);
    expect(children.getChild(directory)?.getState().session_status[sessionID]).toEqual({ type: 'idle' });
    const text = await render(sessionID);
    expect(text).toContain(reason);
    expect(text).not.toContain('stopped this reply');
    if (status === 503) {
      // Keep this first: on the old code the failure is the false "not sent" title.
      expect(text).not.toContain('This message was not sent');
      expect(text).toContain('Message delivery is unconfirmed');
    } else expect(text).toContain('This message was not sent');
    const notice = useNotificationStore.getState().list.filter(entry => entry.session === sessionID).at(-1);
    expect(notice).toMatchObject({ type: 'error', sendOutcome: status === 503 ? 'unconfirmed' : 'refused',
      error: { name: null, message: reason } });
  } finally {
    takePendingSteer(runtimeKey, sessionID, `msg_${sessionID}`);
    setImperativeSessionMessageLoader(null);
    loader?.dispose();
    children.disposeAll();
    globalThis.fetch = originalFetch;
  }
};

for (const confirmation of ['failed', 'empty'] as const) {
  test(`a real 503 with ${confirmation} confirmation reads is unconfirmed, never not sent or a stopped reply`,
    async () => sendAndRender(`s-unconfirmed-${confirmation}`, 503, confirmation));
}

test('a real prompt-blocked 409 remains a definite refusal, not an unconfirmed send',
  async () => sendAndRender('s-blocked', 409, 'empty'));

test('a reply the session stopped keeps "stopped this reply"', async () => {
  useNotificationStore.getState().append({ type: 'error', session: 's-stopped', directory: '/fixture', time: Date.now(), viewed: true,
    error: { name: 'APIError', message: 'Pi disconnected; operation outcome may be unknown.' } });
  const text = await render('s-stopped');
  expect(text).toContain('stopped this reply');
  expect(text).not.toContain('This message was not sent');
});
