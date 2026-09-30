import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createMessageQueueRuntime, registerMessageQueueRoutes } from '../../../web/server/lib/message-queue/runtime.js';
import { initializeRuntimeEndpoint, getRuntimeKey } from '@/lib/runtime-switch';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import { createMessageQueueTarget, useMessageQueueStore } from './messageQueueStore';

test('store reorder reaches the real route with retained custody and cannot cross its barrier', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-queue-order-'));
    const originalFetch = globalThis.fetch;
    const resolver = getRuntimeUrlResolver();
    const initial = useMessageQueueStore.getState();
    const runtime = createMessageQueueRuntime({ dataDir,
        globalEventHub: { subscribeEvent: () => () => {}, subscribeStatus: () => () => {} },
        buildOpenCodeUrl: route => `http://queue.test${route}`, getOpenCodeAuthHeaders: () => ({}),
        fetchImpl: async url => {
            if (new URL(url).pathname !== '/global/health') throw new Error('Unexpected backend IO');
            return Response.json({ healthy: true });
        },
    });
    const routes = new Map();
    const register = method => (route, handler) => routes.set(`${method} ${route}`, handler);
    registerMessageQueueRoutes({ get: register('GET'), post: register('POST'), put: register('PUT'), delete: register('DELETE') }, runtime);
    const statuses = [];
    const orders = [];
    // smarty-code#996 item 3: wait for the route's responses themselves (the event), not a budget of 50 x 2 ms polls
    // (~100 ms; a loaded runner missed it: run 36585425342, statuses[1] undefined). 10 s is only a hang guard.
    const responded = [];
    const responses = n => statuses.length >= n ? Promise.resolve() : Promise.race([
        new Promise(resolve => responded.push({ n, resolve })), sleep(10_000)]);
    try {
        initializeRuntimeEndpoint({ apiBaseUrl: 'http://queue.test', runtimeKey: 'queue-order-test' });
        configureRuntimeUrlResolver({ apiBaseUrl: 'http://queue.test' });
        const owner = createMessageQueueTarget('session-order', '/repo', getRuntimeKey());
        runtime.setHold(owner.sessionId, true);
        for (const id of ['before-barrier', 'taken-barrier', 'pending-first', 'pending-second']) {
            await runtime.enqueue(owner.sessionId, owner.directory, { content: id, text: id, attachments: [], context: [], sendConfig: { providerID: 'p', modelID: 'm' } }, id);
        }
        await runtime.take(owner.sessionId, 'taken-barrier');
        globalThis.fetch = async (input, init) => {
            const request = new Request(input, init);
            if (new URL(request.url).hostname !== 'queue.test') throw new Error('Unexpected external IO');
            const route = request.method === 'GET' ? '/api/message-queue' : '/api/message-queue/sessions/:sessionId/order';
            const handler = routes.get(`${request.method} ${route}`);
            if (!handler) throw new Error('Unexpected queue route');
            const body = request.method === 'GET' ? undefined : await request.json();
            if (body) orders.push(body.itemIds);
            let status = 200;
            let response;
            await handler({ params: { sessionId: owner.sessionId }, body }, {
                status(code) { status = code; return this; },
                json(value) { response = Response.json(value, { status }); },
            });
            statuses.push(status);
            for (const waiter of responded.filter(w => statuses.length >= w.n)) waiter.resolve();
            return response;
        };
        useMessageQueueStore.setState({ queuedMessages: {}, recoveryMessages: {}, sendingIds: {} });
        await useMessageQueueStore.getState().hydrate();
        useMessageQueueStore.getState().reorderQueue(owner, 'pending-second', 'pending-first');
        await responses(2);
        await sleep(0);
        expect(orders[0]).toEqual(['before-barrier', 'pending-second', 'pending-first']);
        expect(statuses[1]).toBe(200);
        expect(runtime.sessionSnapshot(owner.sessionId).items.map(item => item.id)).toEqual(['before-barrier', 'taken-barrier', 'pending-second', 'pending-first']);
        expect(useMessageQueueStore.getState().getQueueForTarget(owner).map(item => item.id)).toEqual(orders[0]);
        const before = runtime.snapshot();
        useMessageQueueStore.getState().reorderQueue(owner, 'pending-first', 'before-barrier');
        await responses(4);
        await sleep(0);
        expect(statuses[2]).toBe(409);
        expect(runtime.snapshot()).toEqual(before);
        expect(useMessageQueueStore.getState().getQueueForTarget(owner).map(item => item.id)).toEqual(orders[0]);
        for (const itemIds of [['pending-first'], ['before-barrier', 'pending-first', 'pending-first']]) {
            const response = await globalThis.fetch('http://queue.test/api/message-queue/sessions/session-order/order', {
                method: 'PUT', body: JSON.stringify({ itemIds }),
            });
            expect(response.status).toBe(400);
        }
        expect((await runtime.recover(owner.sessionId, 'taken-barrier')).item.state).toBe('taken');
    } finally {
        runtime.stop(); await runtime.flush();
        globalThis.fetch = originalFetch; setRuntimeUrlResolver(resolver); useMessageQueueStore.setState(initial, true);
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});
