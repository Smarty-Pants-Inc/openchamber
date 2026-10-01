import { expect, test, spyOn } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRuntimeOpencodeClient } from './client';
import { switchRuntimeEndpoint } from '../runtime-switch';
import { deferred } from '../runtime-isolation-fixture';

// Dispatch mutations using the official SDK, then rebind the same runtime while its accepted body is pending.
for (const method of ['PATCH', 'DELETE'] as const) {
  test(`accepted ${method} body returns to its origin across a same-key rebind`, async () => {
    const body = deferred<ReadableStreamDefaultController<Uint8Array>>();
    const readingBody = deferred<void>();
    const calls: string[] = [];
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (!new URL(request.url).pathname.endsWith('/session/session')) return Response.json({});
      calls.push(request.method);
      return new Response(new ReadableStream<Uint8Array>({ start: body.resolve, pull: () => readingBody.resolve() },
        { highWaterMark: 0 }), { headers: { 'content-type': 'application/json', 'x-origin-receipt': method } });
    });
    const runtime = { apiBaseUrl: 'http://synthetic.invalid', runtimeKey: `accepted-${method}` };
    switchRuntimeEndpoint(runtime);
    const sdk = createRuntimeOpencodeClient({ baseUrl: 'http://synthetic.invalid/api', requestTimeoutMs: 1000 });
    const receipt = method === 'PATCH'
      ? { id: 'session', time: { archived: 1 } }
      : true;
    const pending = method === 'PATCH'
      ? sdk.session.update({ sessionID: 'session', time: { archived: 1 } }, { throwOnError: true })
      : sdk.session.delete({ sessionID: 'session' }, { throwOnError: true });
    // Attach a rejection handler before releasing the body so RED runs cannot leak a rejection.
    const result = pending.then(value => value, error => ({ error }));
    const controller = await body.promise;
    let closed = false;
    try {
      await readingBody.promise;
      switchRuntimeEndpoint(runtime);
      controller.enqueue(new TextEncoder().encode(JSON.stringify(receipt))); controller.close(); closed = true;
      const accepted = await result;
      expect('error' in accepted).toBe(false);
      if ('error' in accepted) throw accepted.error;
      expect(accepted.data).toEqual(receipt);
      expect(accepted.response.headers.get('x-origin-receipt')).toBe(method);
      expect(calls).toEqual([method]);
    } finally {
      if (!closed) { controller.enqueue(new TextEncoder().encode(JSON.stringify(receipt))); controller.close(); }
      await result; fetch.mockRestore();
    }
  });
}

// Use the real SDK and runtimeFetch. Headers are ready while the JSON body is still pending.
for (const source of ['caller', 'native-timeout', 'fallback-timeout'] as const) {
  test(`without AbortSignal.any, ${source} cancels a body after headers`, async () => {
    const any = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
    const timeout = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });
    if (source === 'fallback-timeout') Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
    const headers = deferred<AbortSignal>();
    let failBody = () => {};
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (!new URL(request.url).pathname.endsWith('/message')) return Response.json({});
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode('['));
        failBody = () => controller.error(new DOMException('body aborted', 'AbortError'));
        request.signal.addEventListener('abort', failBody, { once: true });
        headers.resolve(request.signal);
      } }), { headers: { 'content-type': 'application/json' } });
    });
    switchRuntimeEndpoint({ apiBaseUrl: 'http://synthetic.invalid', runtimeKey: `body-${source}` });
    const sdk = createRuntimeOpencodeClient({ baseUrl: 'http://synthetic.invalid/api', requestTimeoutMs: source === 'caller' ? 1000 : 30 });
    const caller = new AbortController();
    const reading = sdk.session.messages({ sessionID: 'session', directory: '/project' }, { signal: caller.signal, throwOnError: true })
      .then(() => null, error => error);
    try {
      const transport = await headers.promise;
      await sleep(5); // runtimeFetch has returned its Response to the wrapper.
      if (source === 'caller') caller.abort(new DOMException('navigation cancelled', 'AbortError'));
      await sleep(source === 'caller' ? 10 : 60);
      const cancelled = transport.aborted;
      failBody(); // Settle even on the RED baseline; never leave a pending SDK read.
      const error = await reading;
      expect(cancelled).toBe(true);
      expect(error).toBeInstanceOf(Error);
      if (source !== 'caller') expect(error.message).toContain('request timed out after 30ms');
    } finally {
      failBody(); await reading; fetch.mockRestore();
      if (any) Object.defineProperty(AbortSignal, 'any', any); else Reflect.deleteProperty(AbortSignal, 'any');
      if (timeout) Object.defineProperty(AbortSignal, 'timeout', timeout); else Reflect.deleteProperty(AbortSignal, 'timeout');
    }
  });
}

test('body completion clears fallback timeout and preserves response metadata', async () => {
  const any = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
  const timeout = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
  Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });
  Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
  let transport: AbortSignal | undefined;
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    transport = new Request(input, init).signal;
    const response = Response.json([]);
    Object.defineProperties(response, { url: { value: 'http://synthetic.invalid/api/session/session/message' }, redirected: { value: true } });
    return response;
  });
  switchRuntimeEndpoint({ apiBaseUrl: 'http://synthetic.invalid', runtimeKey: 'body-complete' });
  const sdk = createRuntimeOpencodeClient({ baseUrl: 'http://synthetic.invalid/api', requestTimeoutMs: 30 });
  try {
    const result = await sdk.session.messages({ sessionID: 'session' }, { signal: new AbortController().signal });
    expect(result.data).toEqual([]);
    expect(result.response.url).toBe('http://synthetic.invalid/api/session/session/message');
    expect(result.response.redirected).toBe(true);
    expect(result.response.headers.get('content-type')).toContain('application/json');
    await sleep(60);
    expect(transport?.aborted).toBe(false);
  } finally {
    fetch.mockRestore();
    if (any) Object.defineProperty(AbortSignal, 'any', any); else Reflect.deleteProperty(AbortSignal, 'any');
    if (timeout) Object.defineProperty(AbortSignal, 'timeout', timeout); else Reflect.deleteProperty(AbortSignal, 'timeout');
  }
});
