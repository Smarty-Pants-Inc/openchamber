import { afterEach, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { z } from 'zod';
import { opencodeClient } from './client';
import { NativeCreationError } from './nativeCreation';
import { configureRuntimeUrlResolver } from '../runtime-url';

const directory = '/owned-project';
const sessionID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const requestID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const operation = { operationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', directory,
  generation: null, revision: 0, phase: 'starting', expiresAt: Date.now() + 300_000, canInitialReady: false };
type FixtureCapabilities = { ordinaryInteractiveCreate: 1; ordinaryResume?: 1 };
const servers: Server[] = [];
afterEach(async () => {
  configureRuntimeUrlResolver({}); opencodeClient.reconnectToRuntimeBaseUrl();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error && (!('code' in error) || error.code !== 'ERR_SERVER_NOT_RUNNING') ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
});
async function fixture(supported: boolean) {
  const requests: Array<{ method: string; url: URL; body: string }> = [];
  const capabilities: FixtureCapabilities = { ordinaryInteractiveCreate: 1 };
  if (supported) capabilities.ordinaryResume = 1;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += String(chunk);
    const url = new URL(request.url!, 'http://localhost');
    requests.push({ method: request.method!, url, body });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(url.pathname === '/api/global/health'
      ? { healthy: true, capabilities }
      : { nativeCreation: operation }));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = z.object({ port: z.number().int().positive().max(65535) }).parse(server.address());
  configureRuntimeUrlResolver({ apiBaseUrl: `http://127.0.0.1:${address.port}` }); opencodeClient.reconnectToRuntimeBaseUrl();
  return requests;
}

test('a gateway without the versioned resume capability refuses before a resume POST', async () => {
  const requests = await fixture(false);
  let failure: unknown;
  try { await opencodeClient.resumeNativeSession(directory, sessionID, requestID); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(NativeCreationError);
  if (!(failure instanceof NativeCreationError)) throw Error('Missing definite unsupported refusal');
  expect(failure.code).toBe('unsupported'); expect(failure.status).toBe(501);
  expect(requests.map(request => request.method)).toEqual(['GET']);
  expect(requests[0].url.pathname).toBe('/api/global/health');
  expect(requests[0].url.searchParams.get('directory')).toBe(directory);
});

test('a selected supported gateway receives one unchanged resume request after health admission', async () => {
  const requests = await fixture(true);
  expect(await opencodeClient.resumeNativeSession(directory, sessionID, requestID)).toEqual(operation);
  const posts = requests.filter(request => request.method === 'POST'); expect(posts).toHaveLength(1);
  expect(posts[0].url.pathname).toBe('/api/session/creation/resume');
  expect(posts[0].url.searchParams.get('directory')).toBe(directory);
  expect(JSON.parse(posts[0].body)).toEqual({ sessionID, clientRequestId: requestID });
});
