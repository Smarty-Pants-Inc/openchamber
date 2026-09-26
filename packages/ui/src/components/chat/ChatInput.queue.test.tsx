import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { errors, mountedNativeComposer, shownActivity } from './composer/submit/__tests__/nativeComposer.fixture';
import { deferred, directory, session } from '@/sync/native-draft-fixture';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInputStore } from '@/sync/input-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { ChatColumnSessionContext, type ChatColumnSession } from './chatColumnSession';

let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
const initialAutoReview = useAutoReviewStore.getState();
const initialQueue = useMessageQueueStore.getState();
afterEach(async () => {
    await mounted?.dispose(); mounted = undefined;
    shownActivity.phase = 'idle';
    useAutoReviewStore.setState(initialAutoReview, true);
    useMessageQueueStore.setState(initialQueue, true);
});

async function composer(body?: Parameters<typeof mountedNativeComposer>[3]) {
    const c = mounted = await mountedNativeComposer(false, undefined, undefined, body);
    await act(async () => {
        useSessionUIStore.setState(state => ({ currentSessionId: session.id, currentSessionDirectory: directory,
            newSessionDraft: { ...state.newSessionDraft, open: false } }));
        useConfigStore.setState({ currentProviderId: 'p', currentModelId: 'm' });
        useAutoReviewStore.getState().upsertRun({ originalSessionID: session.id, reviewSessionID: 'review-test', directory,
            runtimeKey: c.runtimeA, status: 'running', phase: 'waiting_for_reviewer', iteration: 1, maxIterations: 2 });
        useInlineCommentDraftStore.getState().addDraft({ directory, sessionKey: session.id }, {
            source: 'file', fileLabel: 'context.ts', startLine: 1, endLine: 1, code: 'context', language: 'ts', text: 'inline context',
        });
        useMessageQueueStore.setState({ queuedMessages: {}, recoveryMessages: {}, sendingIds: {} });
    });
    await c.replace('queue this');
    return c;
}

function queueTransport(respond: (request: Request) => Promise<Response>) {
    const otherFetch = globalThis.fetch;
    const requests: Request[] = [];
    globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname.startsWith('/api/message-queue')) {
            requests.push(request.clone());
            return respond(request);
        }
        return otherFetch(input, init);
    };
    return requests;
}

test('mounted queue refusal leaves text, files, synthetic and inline context untouched', async () => {
    const c = await composer();
    const requests = queueTransport(async () => Response.json({ error: 'unsupported' }, { status: 501 }));
    const input = useInputStore.getState();
    const inline = useInlineCommentDraftStore.getState().getDrafts({ directory, sessionKey: session.id });
    const nativeRequests = c.requests.length;
    await c.submit();
    expect(requests.map(request => request.method)).toEqual(['GET']);
    expect(c.text()).toBe('queue this');
    expect(useInputStore.getState()).toBe(input);
    expect(useInlineCommentDraftStore.getState().getDrafts({ directory, sessionKey: session.id })).toBe(inline);
    expect(c.requests).toHaveLength(nativeRequests);
    expect(c.prompts()).toHaveLength(0);
});

test('held queue ACK consumes nothing; acceptance preserves newer typing and attachments', async () => {
    const c = await composer();
    const held = deferred<Response>();
    const requests = queueTransport(async request => request.method === 'GET' ? Response.json({ supported: true }) : held.promise);
    const oldInput = useInputStore.getState();
    await c.submit();
    expect(requests.map(request => request.method)).toEqual(['GET', 'POST']);
    expect(c.text()).toBe('queue this');
    expect(useInputStore.getState()).toBe(oldInput);
    await c.replace('newer text');
    const newFile = { ...oldInput.attachedFiles[0], id: 'newer-file' };
    await act(async () => { useInputStore.setState({ attachedFiles: [...oldInput.attachedFiles, newFile] }); });
    await act(async () => {
        held.resolve(Response.json({ revision: 1, session: { sessionId: session.id, directory, sendingId: null, items: [] } }));
        await sleep(0);
    });
    expect(c.text()).toBe('newer text');
    expect(useInputStore.getState().attachedFiles).toEqual([newFile]);
    expect(useInputStore.getState().pendingSyntheticParts).toEqual([]);
    expect(useInlineCommentDraftStore.getState().getDrafts({ directory, sessionKey: session.id })).toEqual([]);
});

test('held preflight captures only the context present with the submitted text', async () => {
    const c = await composer();
    const preflight = deferred<Response>();
    const requests = queueTransport(async request => request.method === 'GET' ? preflight.promise
        : Response.json({ revision: 1, session: { sessionId: session.id, directory, sendingId: null, items: [] } }));
    await c.submit();
    expect(requests.map(request => request.method)).toEqual(['GET']);
    await c.replace('newer input');
    const newerPart = { text: 'newer synthetic', synthetic: true };
    await act(async () => {
        useInputStore.setState(state => ({ pendingSyntheticParts: [...state.pendingSyntheticParts ?? [], newerPart] }));
        useInlineCommentDraftStore.getState().addDraft({ directory, sessionKey: session.id }, {
            source: 'file', fileLabel: 'new.ts', startLine: 1, endLine: 1, code: 'new', language: 'ts', text: 'newer inline',
        });
        preflight.resolve(Response.json({ supported: true }));
        await sleep(0);
    });
    const body = await requests.find(request => request.method === 'POST')?.json();
    expect(body.item.content).toBe('queue this');
    const texts = body.item.context.map((part: { text: string }) => part.text).join('\n');
    expect(texts).toContain('inline context');
    expect(texts).not.toContain('newer synthetic');
    expect(texts).not.toContain('newer inline');
    expect(c.text()).toBe('newer input');
    expect(useInputStore.getState().pendingSyntheticParts).toEqual([newerPart]);
    expect(useInlineCommentDraftStore.getState().getDrafts({ directory, sessionKey: session.id }).map(draft => draft.text)).toEqual(['newer inline']);
});

test('a queue write refusal preserves the complete live input without restore races', async () => {
    const c = await composer();
    const requests = queueTransport(async request => request.method === 'GET' ? Response.json({ supported: true }) : Response.json({ error: 'full' }, { status: 409 }));
    const input = useInputStore.getState();
    await c.submit();
    expect(requests.map(request => request.method)).toEqual(['GET', 'POST']);
    expect(c.text()).toBe('queue this');
    expect(useInputStore.getState()).toBe(input);
});

test('an unknown queue admission keeps live input and a second submit cannot replay it', async () => {
    const c = await composer();
    const requests = queueTransport(async request => {
        if (new URL(request.url).pathname.endsWith('/admission')) return Response.json({ supported: true });
        if (request.method === 'POST') throw new Error('response lost after admission');
        return Response.json({ revision: 2, sessions: [] });
    });
    await c.submit();
    expect(c.text()).toBe('queue this');
    await c.submit();
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
    expect(c.prompts()).toHaveLength(0);
    expect(Object.values(useMessageQueueStore.getState().recoveryMessages).flat()[0].state).toBe('unconfirmed');
});

// F11: a missed session.idle left the page 'working', so Send took the queue route for a session idle on the server.
async function shownWorking(serverStatus: Record<string, unknown> | (() => Promise<Response>),
    body?: Parameters<typeof mountedNativeComposer>[3]) {
    const c = await composer(body);
    await act(async () => {
        useAutoReviewStore.setState(initialAutoReview, true);
        c.children.ensureChild(directory, { bootstrap: false }).setState({ session_status: { [session.id]: { type: 'busy' } } });
        shownActivity.phase = 'busy';
    });
    const statusReads: Request[] = [];
    const queue = queueTransport(async request => request.method === 'GET' ? Response.json({ supported: true })
        : Response.json({ revision: 1, session: { sessionId: session.id, directory, sendingId: null, items: [] } }));
    const queueFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname.endsWith('/session/status')) {
            statusReads.push(request);
            return typeof serverStatus === 'function' ? serverStatus() : Response.json(serverStatus);
        }
        return queueFetch(input, init);
    };
    await act(async () => { c.rerender(); });
    return { c, queue, statusReads };
}

test('Send re-reads a session shown working and sends directly when the server says idle', async () => {
    const { c, queue, statusReads } = await shownWorking({});
    await c.submit(); await act(async () => { await sleep(10); });
    expect(statusReads).toHaveLength(1);
    expect(queue).toHaveLength(0);
    expect(c.prompts()).toHaveLength(1);
});

test('Send still queues when the server confirms the session is working', async () => {
    const { c, queue, statusReads } = await shownWorking({ [session.id]: { type: 'busy' } });
    await c.submit(); await act(async () => { await sleep(10); });
    expect(statusReads).toHaveLength(1);
    expect(queue.map(request => request.method)).toEqual(['GET', 'POST']);
    expect(c.prompts()).toHaveLength(0);
});

// Review P1 on #221: the composer stays mounted across session selections, so a Send held on the status read must not
// send or queue the NEXT session's draft (or queue it to the first session) once the read returns.
const holds = { idle: () => Response.json({}), busy: () => Response.json({ [session.id]: { type: 'busy' } }),
    failed: () => new Response('down', { status: 500 }) };
for (const [name, reply] of Object.entries(holds)) {
    test(`a session switch during a held status read (${name}) sends and queues nothing`, async () => {
        const held = deferred<Response>();
        const { c, queue, statusReads } = await shownWorking(() => held.promise);
        errors.length = 0;
        await c.submit();
        expect(statusReads).toHaveLength(1);
        await act(async () => { useSessionUIStore.setState({ currentSessionId: 'ses-b-other' }); });
        await c.replace('B draft');
        await act(async () => { held.resolve(reply()); await sleep(10); });
        expect(c.prompts()).toHaveLength(0);
        expect(queue.filter(request => request.method === 'POST')).toHaveLength(0);
        expect(c.text()).toBe('B draft');
        expect(errors.some(message => message.startsWith('Nothing was sent'))).toBe(true);
    });
}

test('an edit during a held status read cancels the send; the edited text stays', async () => {
    const held = deferred<Response>();
    const { c, queue } = await shownWorking(() => held.promise);
    await c.submit();
    await c.replace('queue this, edited');
    await act(async () => { held.resolve(Response.json({})); await sleep(10); });
    expect(c.prompts()).toHaveLength(0);
    expect(queue.filter(request => request.method === 'POST')).toHaveLength(0);
    expect(c.text()).toBe('queue this, edited');
});

test('repeated Sends while the status read is held make one read and one send', async () => {
    const held = deferred<Response>();
    const { c, queue, statusReads } = await shownWorking(() => held.promise);
    await c.submit(); await c.submit(); await c.submit();
    expect(statusReads).toHaveLength(1);
    await act(async () => { held.resolve(Response.json({})); await sleep(10); });
    expect(c.prompts()).toHaveLength(1);
    expect(queue).toHaveLength(0);
});

// smarty-dev#777 gap 5: under load the history view refreshes all the time. A refresh during the held status read
// replaces objects (the view, the files array, the session record) but changes nothing the person sees: it must send.
for (const [name, reply] of Object.entries({ idle: holds.idle, busy: holds.busy })) {
  test(`a view refresh during a held status read (${name}) still sends or queues exactly once`, async () => {
    const held = deferred<Response>();
    const { c, queue, statusReads } = await shownWorking(() => held.promise);
    errors.length = 0;
    await c.submit();
    expect(statusReads).toHaveLength(1);
    await act(async () => {
      // The loader re-reads the view; the stores publish new, equal objects.
      await c.loader.refreshOrdinaryView({ directory, sessionID: session.id }).catch(() => undefined);
      const input = useInputStore.getState();
      useInputStore.setState({ attachedFiles: input.attachedFiles.map((file) => ({ ...file })) });
      const child = c.children.getChild(directory)!;
      child.setState((state) => ({ session: state.session.map((record) => ({ ...record })) }));
      useSessionUIStore.setState((state) => ({ currentSessionId: state.currentSessionId }));
    });
    await act(async () => { held.resolve(reply()); await sleep(10); });
    expect(errors.filter((message) => message.startsWith('Nothing was sent'))).toEqual([]);
    expect(c.prompts().length + queue.filter((request) => request.method === 'POST').length).toBe(1);
  });
}

test('a changed attachment during a held status read still cancels', async () => {
  const held = deferred<Response>();
  const { c, queue } = await shownWorking(() => held.promise);
  errors.length = 0;
  await c.submit();
  await act(async () => { useInputStore.setState({ attachedFiles: [] }); });
  await act(async () => { held.resolve(holds.idle()); await sleep(10); });
  expect(c.prompts()).toHaveLength(0);
  expect(queue.filter((request) => request.method === 'POST')).toHaveLength(0);
  expect(errors.some((message) => message.startsWith('Nothing was sent'))).toBe(true);
});

// Astra pre-check on the gap-5 fix: the session the composer shows (the chat column's, which can lag the store's
// selection) is compared too. The store already selects B while the column still shows A; Send checks A; the column
// then catches up to B with the same text. Nothing may go to B.
test('the chat column catching up to another session during a held status read cancels, even with the same text', async () => {
    const { ChatInput } = await import('./ChatInput');
    let column: ChatColumnSession = { sessionId: session.id, directory };
    const held = deferred<Response>();
    const { c, queue } = await shownWorking(() => held.promise,
        () => <ChatColumnSessionContext.Provider value={column}><ChatInput /></ChatColumnSessionContext.Provider>);
    await act(async () => { useSessionUIStore.setState({ currentSessionId: 'ses-b-other' }); c.rerender(); });
    errors.length = 0;
    await c.submit();
    await act(async () => { column = { sessionId: 'ses-b-other', directory }; c.rerender(); });
    await c.replace('queue this'); // B's draft reads exactly like A's.
    await act(async () => { held.resolve(holds.idle()); await sleep(10); });
    expect(c.prompts()).toHaveLength(0);
    expect(queue.filter((request) => request.method === 'POST')).toHaveLength(0);
    expect(errors.some((message) => message.startsWith('Nothing was sent'))).toBe(true);
});

test('an attachment replaced under the same id with other content during a held status read cancels', async () => {
    const held = deferred<Response>();
    const { c } = await shownWorking(() => held.promise);
    errors.length = 0;
    await c.submit();
    await act(async () => {
        useInputStore.setState((state) => ({ attachedFiles: state.attachedFiles.map((file) => ({ ...file, dataUrl: 'data:text/plain;base64,b3RoZXI=' })) }));
    });
    await act(async () => { held.resolve(holds.idle()); await sleep(10); });
    expect(c.prompts()).toHaveLength(0);
    expect(errors.some((message) => message.startsWith('Nothing was sent'))).toBe(true);
});

test('after a view refresh, an accepted queue clears the attachments it took from the composer', async () => {
    const held = deferred<Response>();
    const { c, queue } = await shownWorking(() => held.promise);
    expect(useInputStore.getState().attachedFiles.length).toBeGreaterThan(0);
    await c.submit();
    await act(async () => { useInputStore.setState((state) => ({ attachedFiles: state.attachedFiles.map((file) => ({ ...file })) })); });
    await act(async () => { held.resolve(holds.busy()); await sleep(20); });
    expect(queue.filter((request) => request.method === 'POST')).toHaveLength(1);
    expect(useInputStore.getState().attachedFiles).toEqual([]);
});
