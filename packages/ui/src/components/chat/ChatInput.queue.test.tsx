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

let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
const initialAutoReview = useAutoReviewStore.getState();
const initialQueue = useMessageQueueStore.getState();
afterEach(async () => {
    await mounted?.dispose(); mounted = undefined;
    shownActivity.phase = 'idle';
    useAutoReviewStore.setState(initialAutoReview, true);
    useMessageQueueStore.setState(initialQueue, true);
});

async function composer() {
    const c = mounted = await mountedNativeComposer(false);
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
async function shownWorking(serverStatus: Record<string, unknown> | (() => Promise<Response>)) {
    const c = await composer();
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
