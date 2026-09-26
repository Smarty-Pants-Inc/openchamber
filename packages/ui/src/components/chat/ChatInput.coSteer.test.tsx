import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { mountedNativeComposer, shownActivity } from './composer/submit/__tests__/nativeComposer.fixture';
import { deferred, directory, session } from '@/sync/native-draft-fixture';
import { abortCurrentOperation } from '@/sync/session-actions';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { toast } from '@/components/ui';

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
