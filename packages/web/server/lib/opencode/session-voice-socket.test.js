import { afterEach, expect, it } from 'bun:test';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

import { attachSessionVoiceSocket } from './session-voice-socket.js';

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }));
  return server.address().port;
};
const reject = (socket, status, message) => {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
};
const human = { version: 1, issuer: 'https://code.example.test', subject: 'person-1', name: 'Person One' };

/** A stand-in Code gateway edge: records the upgrade and echoes frames, or refuses. */
async function gateway({ refuse } = {}) {
  const seen = [];
  const server = http.createServer();
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    seen.push({ url: req.url, headers: req.headers });
    if (refuse) {
      const body = JSON.stringify({ name: 'APIError', data: { message: refuse, isRetryable: false } });
      socket.end(`HTTP/1.1 503 Service Unavailable\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body}`);
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary })));
  });
  cleanup.push(() => { for (const client of sockets.clients) client.terminate(); });
  return { seen, port: await listen(server) };
}

async function edge(gatewayPort, controller) {
  const server = http.createServer();
  const runtime = attachSessionVoiceSocket({
    server,
    getUiAuthController: () => controller,
    rejectWebSocketUpgrade: reject,
    buildOpenCodeUrl: (path) => `http://127.0.0.1:${gatewayPort}${path}`,
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer gateway-token' }),
  });
  cleanup.push(() => runtime.stop());
  return listen(server);
}
const signedIn = {
  humanMode: true,
  requireUpgradeAuth: async (req, socket, next, rejectUpgrade) => {
    if (req.headers.cookie !== 'session=ok') return rejectUpgrade(socket, 401, 'Human authentication required');
    req.humanIdentity = human;
    return next();
  },
};
const open = (port, { cookie = 'session=ok', path = '/api/session/s%201/voice/socket?directory=%2Frepo' } = {}) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { cookie, origin: 'https://code.example.test' } });
  const inbox = [];
  ws.on('message', (data, isBinary) => inbox.push(isBinary ? [...data] : JSON.parse(String(data))));
  ws.once('open', () => resolve({ ws, inbox, closed: new Promise((done) => ws.once('close', (code) => done(code))) }));
  ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  ws.once('error', reject);
});
const until = async (check) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(check()).toBe(true);
};

it('pipes a signed-in human call to the gateway with the server bearer and actor only', async () => {
  const upstream = await gateway();
  const call = await open(await edge(upstream.port, signedIn));
  call.ws.send(JSON.stringify({ type: 'start' })); // May arrive before the gateway opens; it waits.
  await until(() => upstream.seen.length === 1);
  expect(upstream.seen[0].url).toBe('/session/s%201/voice/socket?directory=%2Frepo');
  expect(upstream.seen[0].headers.authorization).toBe('Bearer gateway-token');
  expect(JSON.parse(Buffer.from(upstream.seen[0].headers['x-smarty-human-identity'], 'base64url').toString())).toEqual(human);
  expect(upstream.seen[0].headers.cookie).toBeUndefined();
  expect(upstream.seen[0].headers.origin).toBeUndefined();
  call.ws.send(Buffer.from([1, 2, 3]));
  await until(() => call.inbox.length === 2);
  expect(call.inbox).toEqual([{ type: 'start' }, [1, 2, 3]]);
  call.ws.close();
  await call.closed;
});

it('refuses anonymous, non-human and directory-less upgrades before the gateway', async () => {
  const upstream = await gateway();
  await expect(open(await edge(upstream.port, signedIn), { cookie: 'session=bad' })).rejects.toThrow('HTTP 401');
  await expect(open(await edge(upstream.port, { humanMode: false }))).rejects.toThrow('HTTP 403');
  await expect(open(await edge(upstream.port, signedIn), { path: '/api/session/s/voice/socket' })).rejects.toThrow('HTTP 400');
  expect(upstream.seen).toEqual([]);
});

it('shows a gateway refusal to the page as an ended reason', async () => {
  const upstream = await gateway({ refuse: 'No voice provider is loaded in this session; install GipPity and reload' });
  const call = await open(await edge(upstream.port, signedIn));
  expect(await call.closed).toBe(1000);
  expect(call.inbox).toEqual([{ type: 'ended', reason: 'No voice provider is loaded in this session; install GipPity and reload' }]);
});
