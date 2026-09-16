import { afterEach, beforeEach, expect, test } from 'bun:test';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeKey, initializeRuntimeEndpoint } from '@/lib/runtime-switch';
import { opencodeClient } from '@/lib/opencode/client';
import { checkQueueAdmission, createMessageQueueTarget, getMessageQueueKey, useMessageQueueStore } from './messageQueueStore';

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalResolver = getRuntimeUrlResolver();
let sessionId = '';
const target = () => {
    const value = createMessageQueueTarget(sessionId, '/repo', getRuntimeKey());
    if (!value) throw new Error('Missing synthetic target');
    return value;
};
const item = { content: 'preserve input', text: 'preserve input', sendConfig: { providerID: 'p', modelID: 'm' } };
let requests: Request[] = [];
let respond: (request: Request) => Promise<Response>;

beforeEach(() => {
    sessionId = `session-boundary-${crypto.randomUUID()}`;
    initializeRuntimeEndpoint({ apiBaseUrl: 'http://queue.test', runtimeKey: 'queue-test' });
    configureRuntimeUrlResolver({ apiBaseUrl: 'http://queue.test' });
    opencodeClient.reconnectToRuntimeBaseUrl();
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: 'http://queue.test', href: 'http://queue.test/' } } });
    requests = [];
    respond = async () => Response.json({ healthy: true, version: '1.18.29' });
    globalThis.fetch = async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (new URL(request.url).hostname !== 'queue.test') throw new Error('Refused external test network');
        requests.push(request);
        return respond(request);
    };
    useMessageQueueStore.setState({ queuedMessages: {}, recoveryMessages: {}, quarantinedLegacyMessages: {}, sendingIds: {} });
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    setRuntimeUrlResolver(originalResolver);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
});

const vscode = () => Object.defineProperty(window, '__VSCODE_CONFIG__', { configurable: true, value: {} });

test('ordinary refusal performs only a capability read and no admission or state change', async () => {
    respond = async () => Response.json({ error: 'unsupported' }, { status: 501 });
    await expect(checkQueueAdmission(target())).rejects.toThrow();
    expect(requests.map(request => request.method)).toEqual(['GET']);
    expect(useMessageQueueStore.getState().queuedMessages).toEqual({});
    expect(useMessageQueueStore.getState().recoveryMessages).toEqual({});
});

test('VS Code checks selected backend health, not shell identity or ordinary creator availability', async () => {
    vscode();
    respond = async () => Response.json({ healthy: true, capabilities: { displayAttribution: 1 } });
    await expect(useMessageQueueStore.getState().addToQueue(target(), item)).rejects.toThrow();
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).pathname).toBe('/api/global/health');
    expect(new URL(requests[0].url).searchParams.get('directory')).toBe('/repo');
    expect(useMessageQueueStore.getState().queuedMessages).toEqual({});
});

test('local overflow rejects the next message instead of evicting the first, including an in-flight head', async () => {
    vscode();
    const owner = target();
    const store = useMessageQueueStore.getState();
    for (let i = 0; i < 20; i++) await store.addToQueue(owner, { ...item, content: `message ${i}` });
    const before = store.getQueueForTarget(owner);
    store.markSending(owner, before[0].id);
    await expect(store.addToQueue(owner, item)).rejects.toThrow();
    expect(store.getQueueForTarget(owner).map(message => message.content)).toEqual(before.map(message => message.content));
});

test('foreground admission keeps captured text, agent and context; clear retains only the live attempt', async () => {
    vscode();
    const owner = target();
    const store = useMessageQueueStore.getState();
    const context = [{ kind: 'synthetic' as const, text: 'captured context' }];
    await store.addToQueue(owner, { ...item, content: '@Builder do it', text: 'do it', agentMention: 'Builder', context });
    await store.addToQueue(owner, { content: 'plain' });
    const [captured, plain] = store.getQueueForTarget(owner);
    expect(captured).toMatchObject({ content: '@Builder do it', text: 'do it', agentMention: 'Builder', context });
    expect(plain.text).toBe('plain');
    expect(plain.agentMention).toBeUndefined();
    expect(plain.context).toBeUndefined();
    store.markSending(owner, captured.id);
    store.clearQueue(owner);
    expect(store.getQueueForTarget(owner).map(message => message.id)).toEqual([captured.id]);
    store.clearSending(owner, captured.id);
    await store.addToQueue(owner, { content: 'next' });
    store.clearQueue(owner);
    expect(store.getQueueForTarget(owner)).toEqual([]);
    expect(useMessageQueueStore.getState().recoveryMessages[getMessageQueueKey(owner)][0].id).toBe(captured.id);
});

test('held server admission publishes no optimistic accepted item', async () => {
    let release = (response: Response) => { void response; };
    const held = new Promise<Response>(resolve => { release = resolve; });
    respond = () => held;
    const owner = target();
    const pending = useMessageQueueStore.getState().addToQueue(owner, item);
    await Promise.resolve();
    expect(useMessageQueueStore.getState().getQueueForTarget(owner)).toEqual([]);
    release(Response.json({ error: 'full' }, { status: 409 }));
    await expect(pending).rejects.toThrow();
    expect(useMessageQueueStore.getState().recoveryMessages).toEqual({});
});

test('lost admission response retains full unconfirmed input without automatic POST replay', async () => {
    let posted = 0;
    respond = async (request) => {
        if (request.method === 'POST') { posted++; throw new Error('lost after intake'); }
        return Response.json({ revision: 3, sessions: [] });
    };
    const owner = target();
    const context = [{ kind: 'synthetic' as const, text: 'private context' }];
    await expect(useMessageQueueStore.getState().addToQueue(owner, { ...item, context })).rejects.toThrow();
    const recovery = useMessageQueueStore.getState().recoveryMessages[getMessageQueueKey(owner)];
    expect(recovery[0].state).toBe('unconfirmed');
    expect((await useMessageQueueStore.getState().recoverMessage(owner, recovery[0].id)).context).toEqual(context);
    await expect(useMessageQueueStore.getState().addToQueue(owner, item)).rejects.toThrow();
    await useMessageQueueStore.getState().hydrate();
    expect(posted).toBe(1);
    expect(useMessageQueueStore.getState().recoveryMessages[getMessageQueueKey(owner)][0].state).toBe('unconfirmed');
});

test('a lost admission response reconciles by request ID without a second POST', async () => {
    const owner = target();
    let acceptedId = '';
    respond = async request => {
        if (request.method === 'POST') {
            const body = await request.json();
            acceptedId = body.requestId;
            throw new Error('accepted response lost');
        }
        return Response.json({ revision: 1, sessions: [{ sessionId: owner.sessionId, directory: owner.directory, sendingId: null,
            items: [{ ...item, id: acceptedId, createdAt: 1, attachments: [], state: 'pending' }],
        }] });
    };
    await useMessageQueueStore.getState().addToQueue(owner, item);
    expect(requests.map(request => request.method)).toEqual(['POST', 'GET']);
    expect(useMessageQueueStore.getState().getQueueForTarget(owner)[0].id).toBe(acceptedId);
    expect(useMessageQueueStore.getState().recoveryMessages[getMessageQueueKey(owner)]).toEqual([]);
});

for (const present of [true, false]) test(`older full snapshot preserves newer session recovery; present=${present}`, async () => {
    const owner = target();
    const store = useMessageQueueStore.getState();
    const key = getMessageQueueKey(owner);
    const session = { sessionId: owner.sessionId, directory: owner.directory, sendingId: null, items: [
        { ...item, id: 'revision-item', createdAt: 1, attachments: [], state: 'pending' as const },
    ] };
    store.applyServerSession(session, 9, owner.runtimeKey);
    let release = (response: Response) => { void response; };
    respond = () => new Promise<Response>(resolve => { release = resolve; });
    const hydration = store.hydrate();
    // Reach the real fetch before releasing its delayed full snapshot.
    for (let i = 0; i < 20 && requests.length === 0; i++) await Promise.resolve();
    expect(requests).toHaveLength(1);
    store.applyServerSession({ ...session, sendingId: 'new-attempt', items: [
        { ...session.items[0], state: 'unknown' },
        { ...session.items[0], id: 'new-pending' },
        { ...session.items[0], id: 'new-attempt', state: 'attempting' },
    ] }, 11, owner.runtimeKey);
    const current = useMessageQueueStore.getState();
    const currentRecovery = current.recoveryMessages[key];
    release(Response.json({ revision: 10, sessions: present ? [session] : [] }));
    await hydration;
    expect(store.getQueueForTarget(owner)).toEqual(current.queuedMessages[key]);
    expect(useMessageQueueStore.getState().sendingIds[key]).toEqual(current.sendingIds[key]);
    expect(useMessageQueueStore.getState().recoveryMessages[key]).toEqual(currentRecovery);
    expect(useMessageQueueStore.getState().recoveryMessages[key][0].state).toBe('unknown');
});

test('snapshot uncertainty stays out of both queue chips and sendable work', async () => {
    const owner = target();
    respond = async () => Response.json({ revision: 100, sessions: [{ sessionId: owner.sessionId, directory: owner.directory, sendingId: null, items: [
        { ...item, id: 'unknown-item', createdAt: 1, attachments: [], state: 'unknown' },
    ] }] });
    await useMessageQueueStore.getState().hydrate();
    expect(useMessageQueueStore.getState().getSendableQueue(owner)).toEqual([]);
    expect(useMessageQueueStore.getState().getQueueForTarget(owner)).toEqual([]);
    expect(useMessageQueueStore.getState().recoveryMessages[getMessageQueueKey(owner)][0].state).toBe('unknown');
});
