import { afterEach, expect, spyOn, test } from 'bun:test';
import { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { mountedNativeComposer, shownActivity } from './composer/submit/__tests__/nativeComposer.fixture';
import { deferred, directory, session } from '@/sync/native-draft-fixture';
import { abortCurrentOperation } from '@/sync/session-actions';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { toast } from '@/components/ui';
import { useInputStore } from '@/sync/input-store';

// Co-steer (MVP 1 G5): while an ordinary session's agent works, Send sends. The server steers the message into the
// running turn; the page neither queues it, nor steers locally, nor pre-reads the status.
// The button above Stop is ComposerActionButtons' (ComposerActionButtons.coSteer.test.tsx); this fixture mocks the footer.
let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
afterEach(async () => { await mounted?.dispose(); mounted = undefined; shownActivity.phase = 'idle'; });

const successToasts = () => (toast.success as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(call => String(call[0]));

const target = { generation: 'g1', presentationId: 'run-1' };
const running = { type: 'busy', ordinary: true, ordinaryTarget: target } as const;
const statusOf = (c: Awaited<ReturnType<typeof mountedNativeComposer>>) => c.children.getChild(directory)?.getState().session_status[session.id];

async function ordinaryWorking(reply: () => Response | Promise<Response>) {
  const c = mounted = await mountedNativeComposer(false);
  const other: string[] = [];
  await act(async () => {
    useSessionUIStore.setState(state => ({ currentSessionId: session.id, currentSessionDirectory: directory,
      newSessionDraft: { ...state.newSessionDraft, open: false } }));
    useConfigStore.setState({ currentProviderId: 'p', currentModelId: 'm' });
    c.children.ensureChild(directory, { bootstrap: false }).setState({
      session: [{ ...session, title: 'org', ordinary: { generation: 'g1', sequence: 1, thinkingLevel: 'high',
        model: { providerID: 'p', modelID: 'm', name: 'Model' } } } as never],
      session_status: { [session.id]: running },
    });
    shownActivity.phase = 'busy';
  });
  c.handlers.prompt = async () => reply();
  const fixtureFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(new Request(input, init).url).pathname;
    if (path.endsWith('/session/status') || path.startsWith('/api/message-queue')) other.push(path);
    if (path.endsWith('/abort')) { await fixtureFetch(input, init); return Response.json(true); } // Recorded, then answered.
    return fixtureFetch(input, init);
  };
  await act(async () => { c.rerender(); });
  await c.replace('steer this');
  return { c, other };
}

const steered = () => new Response(null, { status: 204, headers: { 'x-smarty-prompt-delivery': 'steer' } });

test('Send on a working ordinary session sends once, plainly, and says it was delivered while it works', async () => {
  const before = successToasts().length;
  const { c, other } = await ordinaryWorking(steered);
  await c.submit(); await act(async () => { await sleep(10); });
  expect(c.prompts()).toHaveLength(1);
  expect(other).toEqual([]);
  const body = await c.prompts()[0].json();
  expect(body.delivery).toBeUndefined();
  expect(body.parts.map((part: { text?: string }) => part.text)).toContain('steer this');
  expect(successToasts().slice(before)).toEqual(['Delivered to org while it works.']);
});

test('a prompt that started a turn says nothing extra', async () => {
  const before = successToasts().length;
  const { c } = await ordinaryWorking(() => new Response(null, { status: 204, headers: { 'x-smarty-prompt-delivery': 'prompt' } }));
  await c.submit(); await act(async () => { await sleep(10); });
  expect(c.prompts()).toHaveLength(1);
  expect(successToasts().slice(before)).toEqual([]);
});

test('a refused send keeps the session shown working and the text in the composer', async () => {
  const words = 'The session\'s terminal is busy. Nothing was sent.';
  const { c } = await ordinaryWorking(() => Response.json({ name: 'APIError',
    data: { message: words, isRetryable: false, code: 'smarty.prompt-blocked' } }, { status: 409 }));
  await c.submit(); await act(async () => { await sleep(10); });
  expect(c.prompts()).toHaveLength(1);
  expect(c.children.getChild(directory)?.getState().session_status[session.id]?.type).toBe('busy');
  expect(c.text()).toBe('steer this');
});

// Review on #234 (P2 1): a co-steer send leaves the server's status and its ordinary Stop target alone.
test('after a co-steer send, Stop still targets the running turn', async () => {
  const { c } = await ordinaryWorking(steered);
  const seeded = statusOf(c);
  await c.submit(); await act(async () => { await sleep(10); });
  expect(c.prompts()).toHaveLength(1);
  expect(statusOf(c)).toBe(seeded);
  await act(async () => { await abortCurrentOperation(session.id, { status: statusOf(c) }).catch(() => false); });
  const stop = c.requests.find(request => new URL(request.url).pathname.endsWith('/abort'));
  expect(stop?.headers.get('x-smarty-ordinary-generation')).toBe('g1');
  expect(stop?.headers.get('x-smarty-ordinary-presentation-id')).toBe('run-1');
});

for (const [name, newer] of [['idle', { type: 'idle' }], ['a new Stop target', { ...running, ordinaryTarget: { generation: 'g1', presentationId: 'run-2' } }]] as const) {
  test(`a status that changed during a held send (${name}) survives its refusal`, async () => {
    const held = deferred<Response>();
    const { c } = await ordinaryWorking(() => held.promise);
    await c.submit();
    await act(async () => { c.children.getChild(directory)!.setState(state => ({ session_status: { ...state.session_status, [session.id]: newer } })); });
    const current = statusOf(c);
    await act(async () => {
      held.resolve(Response.json({ name: 'APIError', data: { message: 'Nothing was sent.', isRetryable: false, code: 'smarty.prompt-blocked' } }, { status: 409 }));
      await sleep(10);
    });
    expect(statusOf(c)).toBe(current);
  });
}

// Review on #234 (P2 2): the notice is decoration; an accepted send stays accepted whatever the notice does.
test('a notice that fails to show leaves the accepted send in place: no rollback, no second POST', async () => {
  const spy = toast.success as unknown as { mockImplementationOnce: (fn: () => never) => void };
  spy.mockImplementationOnce(() => { throw new Error('notice failed'); });
  const { c } = await ordinaryWorking(steered);
  await c.submit(); await act(async () => { await sleep(10); });
  expect(c.prompts()).toHaveLength(1);
  expect(c.text()).toBe('');
  const messages = c.children.getChild(directory)?.getState().message[session.id] ?? [];
  expect(messages.filter(message => message.role === 'user')).toHaveLength(1);
});

// Astra pre-check: a send from idle sets its own busy; the server then says busy too (an equal status), and the send
// fails. The rollback must not reset the server's busy to idle, or Stop disappears while the agent runs.
test('a failed send from idle keeps a busy status the server sent meanwhile', async () => {
  const held = deferred<Response>();
  const { c } = await ordinaryWorking(() => held.promise);
  await act(async () => { c.children.getChild(directory)!.setState(state => ({ session_status: { ...state.session_status, [session.id]: { type: 'idle' } } })); });
  shownActivity.phase = 'idle';
  await act(async () => { c.rerender(); });
  await c.submit();
  const optimistic = statusOf(c);
  expect(optimistic).toEqual({ type: 'busy' });
  await act(async () => { c.children.getChild(directory)!.setState(state => ({ session_status: { ...state.session_status, [session.id]: { type: 'busy' } } })); });
  const server = statusOf(c);
  await act(async () => {
    held.resolve(Response.json({ name: 'APIError', data: { message: 'Nothing was sent.', isRetryable: false, code: 'smarty.prompt-blocked' } }, { status: 409 }));
    await sleep(10);
  });
  expect(statusOf(c)).toBe(server);
});

// smarty-code#827 (slice 1 on 3.48): a steer's composer emptied at Send, the send then stalled, and nothing was ever sent.
// The composer still clears at Send (the next message is typed clean: kept there, a steer typed during a 10 s admission
// merged into it), and the text is never lost: a failure brings it back, and so does a send left unanswered
// (sendUnconfirmed.ms), with a line; a late delivery clears that copy. While any Send to the session is unconfirmed,
// another explicit Send waits (smarty-code#1378 session fence): nothing more is posted until the outcome is known.
const { sendUnconfirmed } = await import('@/lib/sendUnconfirmed');
const shortWatchdog = () => { const was = sendUnconfirmed.ms; sendUnconfirmed.ms = 300; return () => { sendUnconfirmed.ms = was; }; };
const until = async (ok: () => boolean, ms = 20_000) => { for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await act(async () => { await sleep(25); }); expect(ok()).toBe(true); };
const idsOf = async (c: Awaited<ReturnType<typeof mountedNativeComposer>>) => Promise.all(c.prompts().map(async p => (await p.clone().json()).messageID as string));

test('the composer clears at Send, so the next message is typed clean (no merge into the pending one)', async () => {
  const restore = shortWatchdog();
  try {
    const held = deferred<Response>();
    const { c } = await ordinaryWorking(() => held.promise);
    await c.submit(); await until(() => c.prompts().length === 1);
    expect(c.text()).toBe('');
    await c.replace('the next steer'); // Typed while the first send is still unanswered (the 3.48 merge case).
    await act(async () => { held.resolve(steered()); await sleep(10); });
    expect(c.text()).toBe('the next steer');
    const body = await c.prompts()[0].json();
    expect(body.parts.map((part: { text?: string }) => part.text).join('')).not.toContain('the next steer');
  } finally { restore(); }
});

test('a send left unanswered brings its text back; a late delivery clears that copy again', async () => {
  const restore = shortWatchdog();
  try {
    const held = deferred<Response>();
    const { c } = await ordinaryWorking(() => held.promise);
    await c.submit(); await until(() => c.prompts().length === 1);
    expect(c.text()).toBe('');
    await until(() => c.text() === 'steer this'); // Back, with the "not confirmed yet" line.
    await act(async () => { held.resolve(steered()); await sleep(10); });
    await until(() => c.text() === '');
    expect(c.prompts()).toHaveLength(1);
  } finally { restore(); }
});

test('a refusal after the text came back does not bring it back twice', async () => {
  const restore = shortWatchdog();
  try {
    const held = deferred<Response>();
    const { c } = await ordinaryWorking(() => held.promise);
    await c.submit(); await until(() => c.text() === 'steer this');
    await act(async () => { held.resolve(Response.json({ name: 'APIError', data: { message: 'Nothing was sent.', isRetryable: false } }, { status: 409 })); await sleep(10); });
    expect(c.text()).toBe('steer this');
  } finally { restore(); }
});

const waitingToasts = (info: { mock: { calls: unknown[][] } }, from: number) =>
  info.mock.calls.slice(from).map(call => String(call[0])).filter(text => text === 'Waiting for your last message to be confirmed.');
const refused = () => Response.json({ name: 'APIError', data: { message: 'Nothing was sent.', isRetryable: false } }, { status: 409 });

test('the restored text sent again UNEDITED while the first is unconfirmed is not posted; a late acceptance clears it', async () => {
  const restore = shortWatchdog();
  const info = spyOn(toast, 'info').mockImplementation(() => 'test-toast');
  try {
    const first = deferred<Response>();
    const { c } = await ordinaryWorking(() => first.promise);
    await c.submit(); await until(() => c.text() === 'steer this');
    const before = info.mock.calls.length;
    await c.submit(); await act(async () => { await sleep(100); });
    expect(c.prompts()).toHaveLength(1);
    expect(waitingToasts(info, before)).toHaveLength(1);
    expect(c.text()).toBe('steer this');
    await act(async () => { first.resolve(steered()); await sleep(10); }); // The first is accepted late.
    await until(() => c.text() === '');
    expect(c.prompts()).toHaveLength(1);
  } finally { info.mockRestore(); restore(); }
});

test('the restored text EDITED waits for the first outcome, then goes as a new message (a new client ID)', async () => {
  const restore = shortWatchdog();
  try {
    const first = deferred<Response>();
    let n = 0;
    const { c } = await ordinaryWorking(() => (n++ === 0 ? first.promise : steered()));
    await c.submit(); await until(() => c.text() === 'steer this');
    await c.replace('steer this, edited');
    await c.submit(); await act(async () => { await sleep(100); });
    expect(c.prompts()).toHaveLength(1);
    expect(c.text()).toBe('steer this, edited');
    await act(async () => { first.resolve(refused()); await sleep(20); }); // Known: nothing was sent.
    await c.replace('steer this, edited');
    await c.submit(); await until(() => c.prompts().length === 2);
    const [a, b] = await idsOf(c);
    expect(b).not.toBe(a);
  } finally { restore(); }
});

test('the same text typed again while its send is pending is not posted twice', async () => {
  const restore = shortWatchdog();
  try {
    const held = deferred<Response>();
    const { c } = await ordinaryWorking(() => held.promise);
    // Plain text only (the fixture attaches a file and a context part; retyping cannot bring those, so it would differ).
    await act(async () => { useInputStore.getState().setAttachedFiles([]); useInputStore.getState().setPendingSyntheticParts([]); });
    await c.submit(); await until(() => c.prompts().length === 1);
    await c.replace('steer this');
    await c.submit(); await act(async () => { await sleep(100); });
    expect(c.prompts()).toHaveLength(1);
  } finally { restore(); }
});

// openchamber#375 review round 2 (P1 1), under the session fence: B waits while A is unanswered, and A's recovery
// still gives A's text back next to B's unsent text.
test('two overlapping sends: A never answered, B waits unsent; A\'s text still comes back beside B\'s', async () => {
  const was = sendUnconfirmed.ms; sendUnconfirmed.ms = 1_500;
  const restore = () => { sendUnconfirmed.ms = was; };
  try {
    const first = deferred<Response>();
    let n = 0;
    const { c } = await ordinaryWorking(() => (n++ === 0 ? first.promise : steered()));
    await c.submit(); await until(() => c.prompts().length === 1);
    await c.replace('a second, different steer');
    await c.submit(); await act(async () => { await sleep(100); });
    expect(c.prompts()).toHaveLength(1);
    expect(c.text()).toBe('a second, different steer'); // B stays in the composer, unsent.
    await until(() => c.text().includes('steer this')); // A's watchdog still gives A back.
    expect(c.text()).toContain('a second, different steer');
    expect(c.prompts()).toHaveLength(1);
  } finally { restore(); }
});

// openchamber#375 review 3, P1 2: a preparation that stalls BEFORE the POST (snippet expansion) and a re-send of the
// given-back text: both attempts carry the group's one client ID, so the gateway admits one message.
test('a stalled preparation, the text given back, sent again: both POSTs carry the same client ID', async () => {
  const restore = shortWatchdog();
  const { useSnippetsStore } = await import('@/stores/useSnippetsStore');
  const realExpand = useSnippetsStore.getState().expandText;
  try {
    const held = deferred<string>(); let calls = 0;
    useSnippetsStore.setState({ expandText: async (text: string) => (++calls === 1 ? held.promise : text) });
    const { c } = await ordinaryWorking(steered);
    await c.submit(); await until(() => c.text() === 'steer this'); // No POST yet; given back at the watchdog.
    expect(c.prompts()).toHaveLength(0);
    await c.submit(); await until(() => c.prompts().length === 1);
    await act(async () => { held.resolve('steer this'); await sleep(50); });
    await until(() => c.prompts().length === 2);
    const [a, b] = await idsOf(c);
    expect(b).toBe(a);
  } finally { useSnippetsStore.setState({ expandText: realExpand }); restore(); }
});

// openchamber#375 review 3, P1 1: given back only into its own session's composer: never into another session's composer,
// and back on return. Review 5: its text joins its own saved draft (never over it), so a reload or an unmount keeps it.
test('due while another session is shown: only its own saved draft gets it; it comes back once when its session is shown again', async () => {
  const restore = shortWatchdog();
  const { readChatDraft, createChatDraftIdentity } = await import('@/lib/chatDraftPersistence');
  const { getRuntimeKey } = await import('@/lib/runtime-switch');
  try {
    const held = deferred<Response>();
    const { c } = await ordinaryWorking(() => held.promise);
    await c.submit(); await until(() => c.prompts().length === 1);
    const other = { ...session, id: '01234567-1234-4234-9234-0123456789ff', title: 'other' };
    await act(async () => {
      c.children.getChild(directory)!.setState(state => ({ session: [...state.session, other as never] }));
      useSessionUIStore.setState({ currentSessionId: other.id });
    });
    await act(async () => { c.rerender(); });
    await act(async () => { await sleep(700); }); // Due while `other` is shown.
    expect(c.text()).not.toContain('steer this');
    expect(readChatDraft(createChatDraftIdentity(getRuntimeKey(), directory, session.id)).text).toBe('steer this');
    await act(async () => { useSessionUIStore.setState({ currentSessionId: session.id }); });
    await act(async () => { c.rerender(); });
    await until(() => c.text() === 'steer this');
    await act(async () => { held.resolve(steered()); await sleep(20); }); // Delivered after all: the copy goes.
    await until(() => c.text() === '');
  } finally { restore(); }
});

// smarty-code#962 (3), under the session fence: the given-back text cannot be re-sent while the first is unconfirmed.
// Once the first is accepted late, its copy goes, there is no "Still sending" line, and the next Send is a new message.
test('first attempt accepted late after its text came back: no Still sending toast, and the next Send is a new message', async () => {
  const restore = shortWatchdog();
  const info = spyOn(toast, 'info').mockImplementation(() => 'test-toast');
  const error = spyOn(toast, 'error').mockImplementation(() => 'test-toast');
  try {
    const first = deferred<Response>();
    let n = 0;
    const { c } = await ordinaryWorking(() => (n++ === 0 ? first.promise : steered()));
    await c.submit(); await until(() => c.text() === 'steer this');
    const before = [info.mock.calls.length, error.mock.calls.length];
    await act(async () => { first.resolve(steered()); await sleep(20); });
    await until(() => c.text() === '');
    const lines = [...info.mock.calls.slice(before[0]), ...error.mock.calls.slice(before[1])].map(call => String(call[0]));
    expect(lines.filter(text => text.includes('Still sending'))).toEqual([]);
    await c.replace('a later steer');
    await c.submit(); await until(() => c.prompts().length === 2);
    const [a, b] = await idsOf(c);
    expect(b).not.toBe(a);
  } finally { error.mockRestore(); info.mockRestore(); restore(); }
});
