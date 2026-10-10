import { createServer } from 'node:http';
import { z } from 'zod';
import type { NativeCreationState } from '@/lib/opencode/nativeCreation';

export const target = { directory: '/365 recovery/project', sessionID: 'ses_365_ended' };
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
const resumeBody = z.object({ sessionID: z.string(), clientRequestId: z.uuid() }).strict();
export type Receipt = { url: URL; method: string; body: string; reply: (response: Response) => void; lose: () => void };
export function operation(phase: NativeCreationState['phase'], clientRequestId?: string,
  directory = target.directory): NativeCreationState {
  const value: NativeCreationState = { operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', directory,
    generation: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', revision: 2, phase,
    expiresAt: Date.now() + 300_000, canInitialReady: false };
  if (clientRequestId) value.clientRequestId = clientRequestId;
  return value;
}
export const stateReply = (phase: NativeCreationState['phase'], requestId?: string, directory?: string) =>
  Response.json({ nativeCreation: operation(phase, requestId, directory) }, { status: 202 });
export const failureReply = (status: number) => Response.json({ name: 'APIError',
  data: { message: 'Recovery request refused', isRetryable: false } }, { status });
export const pageReply = (readOnly = false) => Response.json([{
  info: { id: 'msg_365', sessionID: target.sessionID, role: 'user', time: { created: 1 }, agent: 'build',
    model: { providerID: 'preserved-provider', modelID: 'preserved-model' } },
  parts: [{ id: 'part_365', messageID: 'msg_365', sessionID: target.sessionID, type: 'text', text: 'Preserved history' }],
}], { headers: readOnly ? { 'x-smarty-read-only': '1' } : { 'x-smarty-ordinary-view': `ov2_${'a'.repeat(64)}` } });

/** Private HTTP only. Gates hold actual transport replies, never loader methods or client modules. */
export async function recoveryHttp() {
  const page = inbox<Receipt>(), post = inbox<Receipt>(), list = inbox<Receipt>(), read = inbox<Receipt>();
  const requests: Receipt[] = [], releases = new Set<() => void>();
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const method = request.method ?? 'GET';
      const answer = deferred<Response>();
      const lose = () => { response.destroy(); answer.resolve(new Response(null, { status: 500 })); };
      const receipt = { url, method, body, reply: answer.resolve, lose };
      requests.push(receipt); releases.add(lose);
      if (url.pathname.endsWith('/message')) page.put(receipt);
      else if (url.pathname === '/api/session/creation/resume') { resumeBody.parse(JSON.parse(body)); post.put(receipt); }
      else if (url.pathname === '/api/session/creation') list.put(receipt);
      else if (url.pathname.startsWith('/api/session/creation/')) read.put(receipt);
      else if (url.pathname === '/api/global/health') answer.resolve(Response.json({ healthy: true, capabilities: { ordinaryResume: 1 } }));
      else answer.resolve(Response.json({ ignored: true }));
      void answer.promise.then(async value => {
        if (response.destroyed) return;
        response.writeHead(value.status, Object.fromEntries(value.headers));
        response.end(await value.text());
      }).finally(() => releases.delete(lose));
    });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = z.object({ port: z.number() }).parse(server.address());
  return { base: `http://127.0.0.1:${address.port}`, page, post, list, read, requests,
    requestId: (receipt: Receipt) => resumeBody.parse(JSON.parse(receipt.body)).clientRequestId,
    close: async () => {
      for (const release of releases) release();
      const closing = new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
      server.closeAllConnections();
      await closing;
    } };
}
