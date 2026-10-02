// Derived from 365-mounted-http.fixture.ts, OpenChamber contributors, MIT.
// Node HTTP gates expose headers and partial bodies without replacing client or fetch responses.
import { createServer } from 'node:http';
import { z } from 'zod';
import { deferred, operation, pageReply, target } from './365-mounted-http.fixture';
export { operation, pageReply, target };
function inbox<T>() {
  const pending: T[] = [], waiting: Array<(value: T) => void> = [];
  return { put(value: T) { const next = waiting.shift(); if (next) next(value); else pending.push(value); },
    take(): Promise<T> { const value = pending.shift(); return value === undefined
      ? new Promise<T>(done => waiting.push(done)) : Promise.resolve(value); } };
}
const resumeBody = z.object({ sessionID: z.string(), clientRequestId: z.uuid() }).strict();
export type DeadlineReceipt = { url: URL; method: string; body: string; responded: boolean;
  reply: (value: Response) => void; partial: (value: Response) => Promise<() => void>; lose: () => void };
export async function deadlineHttp() {
  const page = inbox<DeadlineReceipt>(), post = inbox<DeadlineReceipt>(), list = inbox<DeadlineReceipt>();
  const read = inbox<DeadlineReceipt>(), health = inbox<DeadlineReceipt>();
  const requests: DeadlineReceipt[] = [], releases = new Set<() => void>();
  const controls = { health: (): Response | null => Response.json({ healthy: true, capabilities: { ordinaryResume: 1 } }),
    session: (): Response => new Response(null, { status: 404 }) };
  const server = createServer((request, response) => {
    let body = ''; request.setEncoding('utf8'); request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1'), method = request.method ?? 'GET';
      const answer = deferred<Response | null>();
      const lose = () => { response.destroy(); answer.resolve(null); };
      const receipt: DeadlineReceipt = { url, method, body, responded: false, reply: answer.resolve, lose,
        partial: async value => {
          answer.resolve(null);
          const text = await value.text();
          response.writeHead(value.status, Object.fromEntries(value.headers));
          response.write(text.slice(0, -1)); response.flushHeaders();
          return () => { response.end(text.slice(-1)); receipt.responded = true; };
        } };
      requests.push(receipt); releases.add(lose);
      if (url.pathname.endsWith('/fs/home')) answer.resolve(Response.json({ home: '/365 mounted', chatsRoot: '/365 mounted/chats' }));
      else if (url.pathname.endsWith('/global/health')) { health.put(receipt); const value = controls.health(); if (value) answer.resolve(value); }
      else if (url.pathname.endsWith('/message')) page.put(receipt);
      else if (url.pathname === '/api/session/creation/resume') { resumeBody.parse(JSON.parse(body)); post.put(receipt); }
      else if (url.pathname === '/api/session/creation') list.put(receipt);
      else if (url.pathname.startsWith('/api/session/creation/')) read.put(receipt);
      else if (url.pathname.endsWith(`/session/${target.sessionID}`)) answer.resolve(controls.session());
      else answer.resolve(new Response(null, { status: 404 }));
      void answer.promise.then(async value => {
        if (!value || response.destroyed) return;
        response.writeHead(value.status, Object.fromEntries(value.headers)); response.end(await value.text()); receipt.responded = true;
      });
      response.on('close', () => releases.delete(lose));
    });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = z.object({ port: z.number() }).parse(server.address());
  return { base: `http://127.0.0.1:${address.port}`, page, post, list, read, health, requests, controls,
    requestId: (receipt: DeadlineReceipt) => resumeBody.parse(JSON.parse(receipt.body)).clientRequestId,
    close: async () => { for (const release of releases) release();
      const closing = new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
      server.closeAllConnections(); await closing; } };
}
