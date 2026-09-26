import { expect, test } from 'bun:test';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { createEventPipeline } from './event-pipeline';

// smarty-dev#777: consecutive streams the server ends soon after opening back off, without delaying this page's own
// reconnects or a failure's own retry policy.
const connected = new TextEncoder().encode(
  `retry: 1\ndata: ${JSON.stringify({ directory: '/repo', payload: { id: 'evt', type: 'server.connected', properties: {} } })}\n\n`);
const endsSoon = () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
  controller.enqueue(connected);
  setTimeout(() => { try { controller.close(); } catch { /* the page cancelled it */ } }, 20);
} }), { headers: { 'content-type': 'text/event-stream' } });
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

test('this page\'s own reconnect ends a short-lived backoff wait at once', async () => {
  const opens: number[] = [];
  const started = Date.now();
  const sdk = createOpencodeClient({ baseUrl: 'https://sync.invalid', fetch: async () => { opens.push(Date.now() - started); return endsSoon(); } });
  const pipeline = createEventPipeline({ sdk, transport: 'sse', onEvent: () => {} });
  try {
    // Opens at about 0, 0.3 and 1.3 s; the next waits 2 s.
    while (opens.length < 3) await sleep(20);
    await sleep(200);
    const before = opens.length, asked = Date.now() - started;
    pipeline.reconnect('manual');
    await sleep(300);
    expect(opens.length).toBe(before + 1);
    expect(opens.at(-1)! - asked).toBeLessThan(300);
  } finally { pipeline.cleanup(); }
}, 10_000);

test('a stream that lives 5 s resets the backoff: the next close reconnects promptly', async () => {
  const opens: number[] = [];
  const started = Date.now();
  let longNext = false;
  const sdk = createOpencodeClient({ baseUrl: 'https://sync.invalid', fetch: async () => {
    opens.push(Date.now() - started);
    if (!longNext) return endsSoon();
    longNext = false;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(connected);
      setTimeout(() => { try { controller.close(); } catch { /* the page cancelled it */ } }, 5_200);
    } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const pipeline = createEventPipeline({ sdk, transport: 'sse', onEvent: () => {} });
  try {
    while (opens.length < 3) await sleep(20); // Backoff has begun (the third open came after 1 s).
    longNext = true;
    while (opens.length < 5) await sleep(20); // The fourth stream lives 5.2 s; the fifth ends soon again.
    while (opens.length < 6) await sleep(20);
    expect(opens[5]! - opens[4]!).toBeLessThan(1_000); // Counted afresh: the first short close is prompt.
  } finally { pipeline.cleanup(); }
}, 20_000);

test('an attempt aborted by the browser (offline) is not counted as a short-lived stream: it retries promptly', async () => {
  const target = globalThis as unknown as { window?: unknown };
  const hadWindow = 'window' in target, previousWindow = target.window;
  target.window = globalThis; // The pipeline listens for online/offline on window.
  const opens: number[] = [];
  const started = Date.now();
  let hangNext = false;
  const sdk = createOpencodeClient({ baseUrl: 'https://sync.invalid', fetch: async (input, init) => {
    const request = new Request(input, init);
    opens.push(Date.now() - started);
    if (!hangNext) return endsSoon();
    hangNext = false;
    // Connected, then silent: this stream only ends when the page aborts it.
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(connected);
      request.signal?.addEventListener('abort', () => { try { controller.close(); } catch { /* closed */ } });
    } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const pipeline = createEventPipeline({ sdk, transport: 'sse', onEvent: () => {} });
  try {
    while (opens.length < 3) await sleep(20); // Backoff has begun.
    hangNext = true;
    while (opens.length < 4) await sleep(20);
    await sleep(100);
    const aborted = Date.now() - started;
    globalThis.dispatchEvent(new Event('offline'));
    while (opens.length < 5 && Date.now() - started < aborted + 3_000) await sleep(20);
    expect(opens.length).toBe(5);
    expect(opens[4]! - aborted).toBeLessThan(1_000); // Not the 4 s a counted short-lived stream would wait.
  } finally {
    pipeline.cleanup();
    if (hadWindow) target.window = previousWindow; else delete target.window;
  }
}, 15_000);
