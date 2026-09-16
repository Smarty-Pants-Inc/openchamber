import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { mountedNativeComposer } from './composer/submit/__tests__/nativeComposer.fixture';
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
