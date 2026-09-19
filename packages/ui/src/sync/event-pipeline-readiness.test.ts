import { expect, spyOn, test } from 'bun:test';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { deferred } from '../lib/runtime-isolation-fixture';
import { createEventPipeline } from './event-pipeline';

const frame = (type: string) => new TextEncoder().encode(
  `retry: 1\ndata: ${JSON.stringify({ directory: '/repo', payload: { id: 'evt', type, properties: {} } })}\n\n`,
);
const stream = () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  return { controller, response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }) };
};

test('a lazy SDK stream and HTTP response do not grant readiness before an event arrives', async () => {
  const requested = deferred<void>();
  const delivered = deferred<void>();
  const wire = stream();
  let connects = 0;
  const sdk = createOpencodeClient({ baseUrl: 'https://sync.invalid', fetch: async () => {
    requested.resolve();
    return wire.response;
  } });
  const pipeline = createEventPipeline({ sdk, transport: 'sse',
    onReconnect: () => { connects += 1; }, onEvent: () => delivered.resolve() });
  try {
    await requested.promise;
    expect(connects).toBe(0);
    wire.controller.enqueue(frame('server.connected'));
    await delivered.promise;
    expect(connects).toBe(1);
  } finally { pipeline.cleanup(); }
});

test('SDK-internal SSE recovery reports one disconnect and a fresh real connection', async () => {
  const first = stream();
  const second = stream();
  const firstDelivered = deferred<void>();
  const secondRequested = deferred<void>();
  const recovered = deferred<void>();
  const heartbeatDelivered = deferred<void>();
  let requests = 0;
  let connects = 0;
  const disconnects: string[] = [];
  const sdk = createOpencodeClient({ baseUrl: 'https://sync.invalid', fetch: async () => {
    requests += 1;
    if (requests === 1) return first.response;
    secondRequested.resolve();
    return second.response;
  } });
  const pipeline = createEventPipeline({ sdk, transport: 'sse',
    onDisconnect: reason => { disconnects.push(reason); },
    onReconnect: () => { connects += 1; },
    onEvent: (_directory, event) => {
      if (event.type === 'server.connected') (requests === 1 ? firstDelivered : recovered).resolve();
      else {
        expect(event.type).toBe('server.heartbeat');
        heartbeatDelivered.resolve();
      }
    } });
  try {
    first.controller.enqueue(frame('server.connected'));
    await firstDelivered.promise;
    expect(connects).toBe(1);
    first.controller.error(new TypeError('controlled stream loss'));
    await secondRequested.promise;
    expect(disconnects).toHaveLength(1);
    expect(connects).toBe(1);
    second.controller.enqueue(frame('server.connected'));
    await recovered.promise;
    expect(connects).toBe(2);
    second.controller.enqueue(frame('server.heartbeat'));
    await heartbeatDelivered.promise;
    expect(connects).toBe(2);
    expect(requests).toBe(2);
  } finally { pipeline.cleanup(); }
});

test('cleanup during SDK acquisition cannot start a heartbeat, fetch, or late publication', async () => {
  let fetches = 0;
  let publications = 0;
  const sdk = createOpencodeClient({ baseUrl: 'https://sync.invalid', fetch: async () => {
    fetches += 1;
    throw new Error('A retired attempt must not start HTTP');
  } });
  const acquired = deferred<ReturnType<typeof sdk.global.event>>();
  const released = deferred<Awaited<ReturnType<typeof sdk.global.event>>>();
  const acquire = sdk.global.event.bind(sdk.global);
  sdk.global.event = (...args) => {
    acquired.resolve(acquire(...args));
    return released.promise;
  };
  const timers = spyOn(globalThis, 'setTimeout');
  const pipeline = createEventPipeline({ sdk, transport: 'sse',
    onReconnect: () => { publications += 1; }, onDisconnect: () => { publications += 1; },
    onEvent: () => { publications += 1; } });
  try {
    const stream = await acquired.promise;
    pipeline.cleanup();
    const timerCount = timers.mock.calls.length;
    released.resolve(stream);
    await released.promise;
    expect(timers.mock.calls).toHaveLength(timerCount);
    expect(fetches).toBe(0);
    expect(publications).toBe(0);
  } finally { pipeline.cleanup(); timers.mockRestore(); }
});

test('cleanup from the real connection callback cannot enqueue its late event', async () => {
  const wire = stream();
  const retired = deferred<void>();
  let publications = 0;
  let timerCount = 0;
  const sdk = createOpencodeClient({ baseUrl: 'https://sync.invalid', fetch: async () => wire.response });
  const timers = spyOn(globalThis, 'setTimeout');
  const pipeline = createEventPipeline({ sdk, transport: 'sse', onEvent: () => { publications += 1; },
    onReconnect: () => {
      pipeline.cleanup();
      timerCount = timers.mock.calls.length;
      retired.resolve();
    } });
  try {
    wire.controller.enqueue(frame('server.connected'));
    await retired.promise;
    expect(timers.mock.calls).toHaveLength(timerCount);
    expect(publications).toBe(0);
  } finally { pipeline.cleanup(); timers.mockRestore(); }
});
