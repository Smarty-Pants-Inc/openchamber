import { createServer } from 'node:http';
import { z } from 'zod';
import type { NativeCreationState } from '@/lib/opencode/nativeCreation';

export const target = { directory: '/365 mounted/project', sessionID: 'ses_365_mounted' };
export function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function inbox<T>() {
  const pending: T[] = [], waiting: Array<(value: T) => void> = [];
  return {
    put(value: T) { const next = waiting.shift(); if (next) next(value); else pending.push(value); },
    take(): Promise<T> { const value = pending.shift(); return value === undefined
      ? new Promise<T>(done => waiting.push(done)) : Promise.resolve(value); },
  };
}
export type Receipt = { url: URL; method: string; responded: boolean; reply: (response: Response) => void };
export function operation(phase: NativeCreationState['phase'], clientRequestId?: string): NativeCreationState {
  const value: NativeCreationState = {
    operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', directory: target.directory,
    generation: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', revision: 2, phase,
    expiresAt: Date.now() + 300_000, canInitialReady: false,
  };
  if (clientRequestId) value.clientRequestId = clientRequestId;
  return value;
}
export const stateReply = (phase: NativeCreationState['phase']) => Response.json({ nativeCreation: operation(phase) }, { status: 202 });
export const pageReply = (readOnly = false) => Response.json([{
  info: { id: 'msg_365', sessionID: target.sessionID, role: 'user', time: { created: 1 }, agent: 'build',
    model: { providerID: 'preserved-provider', modelID: 'preserved-model' } },
  parts: [{ id: 'part_365', messageID: 'msg_365', sessionID: target.sessionID, type: 'text', text: 'Preserved history' }],
}], { headers: readOnly ? { 'x-smarty-read-only': '1' } : { 'x-smarty-ordinary-view': `ov2_${'a'.repeat(64)}` } });

/** Real private HTTP. Gates hold responses, not loader or resume methods. */
export async function mountedHttp() {
  const page = inbox<Receipt>(), post = inbox<Receipt>(), list = inbox<Receipt>(), health = inbox<Receipt>();
  const requests: Receipt[] = [], releases = new Set<() => void>();
  const controls = {
    health: (): Response | Promise<Response> => Response.json({ healthy: true, capabilities: { ordinaryResume: 1 } }),
    session: (): Response => new Response(null, { status: 404 }),
  };
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const method = request.method ?? 'GET', answer = deferred<Response>();
      const release = () => answer.resolve(new Response(null, { status: 503 }));
      const receipt = { url, method, responded: false, reply: answer.resolve };
      requests.push(receipt); releases.add(release);
      if (url.pathname.endsWith('/fs/home')) answer.resolve(Response.json({ home: '/365 mounted', chatsRoot: '/365 mounted/chats' }));
      else if (url.pathname.endsWith('/global/health')) {
        health.put(receipt); void Promise.resolve(controls.health()).then(answer.resolve);
      } else if (url.pathname.endsWith('/message')) page.put(receipt);
      else if (url.pathname === '/api/session/creation/resume') post.put(receipt);
      else if (url.pathname === '/api/session/creation') list.put(receipt);
      else if (url.pathname.endsWith(`/session/${target.sessionID}`)) answer.resolve(controls.session());
      else answer.resolve(new Response(null, { status: 404 }));
      void answer.promise.then(async value => {
        if (response.destroyed) return;
        response.writeHead(value.status, Object.fromEntries(value.headers)); response.end(await value.text()); receipt.responded = true;
      }).finally(() => releases.delete(release));
    });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = z.object({ port: z.number() }).parse(server.address());
  return { base: `http://127.0.0.1:${address.port}`, page, post, list, health, requests, controls,
    close: async () => {
      for (const release of releases) release();
      const closing = new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
      server.closeAllConnections(); await closing;
    } };
}
