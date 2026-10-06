import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, test } from 'vitest';

// Trust-boundary probe for the host-power surfaces removed in smarty-code#1398
// (fs exec, shutdown, update check/install, tunnels, dev-tunnel byte pipe, git
// writes, provider-key routes). It boots the exported server in human mode in
// a separate process (index.js holds import-time HOME paths and singletons),
// signs a real Better Auth session in, and sends every removed route signed
// out and signed in. OpenChamber must not answer any of them itself: signed
// out the API gate refuses (401); signed in the request falls through to the
// gateway proxy, whose stand-in answers 404 like an unknown gateway route.
const REMOVED_HTTP = [
  ['POST', '/api/fs/exec'], ['GET', '/api/fs/exec/job-1'],
  ['GET', '/api/openchamber/update-check'], ['POST', '/api/openchamber/update-install'],
  ['GET', '/api/openchamber/tunnel/check'], ['GET', '/api/openchamber/tunnel/doctor'],
  ['POST', '/api/openchamber/tunnel/doctor'], ['GET', '/api/openchamber/tunnel/providers'],
  ['GET', '/api/openchamber/tunnel/status'], ['PUT', '/api/openchamber/tunnel/managed-remote-token'],
  ['POST', '/api/openchamber/tunnel/start'], ['POST', '/api/openchamber/tunnel/stop'],
  ['GET', '/api/openchamber/relay/status'], ['POST', '/api/openchamber/relay/enable'], ['POST', '/api/openchamber/relay/disable'],
  ['POST', '/api/git/identities'], ['PUT', '/api/git/identities/x'], ['DELETE', '/api/git/identities/x'],
  ['GET', '/api/git/discover-credentials'], ['POST', '/api/git/set-identity'],
  ['POST', '/api/git/integrate/plan'], ['POST', '/api/git/integrate/conflict-details'],
  ['POST', '/api/git/integrate/cherry-pick-status'], ['POST', '/api/git/integrate/run'],
  ['POST', '/api/git/integrate/abort'], ['POST', '/api/git/integrate/continue'],
  ['POST', '/api/git/revert'], ['POST', '/api/git/stage'], ['POST', '/api/git/unstage'],
  ['POST', '/api/git/apply-hunk'], ['POST', '/api/git/pull'], ['POST', '/api/git/push'],
  ['POST', '/api/git/stash'], ['POST', '/api/git/stash/apply'], ['POST', '/api/git/stash/pop'],
  ['POST', '/api/git/stash/drop'], ['POST', '/api/git/fetch'], ['DELETE', '/api/git/remotes'],
  ['POST', '/api/git/rebase'], ['POST', '/api/git/rebase/abort'], ['POST', '/api/git/rebase/continue'],
  ['POST', '/api/git/merge'], ['POST', '/api/git/merge/abort'], ['POST', '/api/git/merge/continue'],
  ['POST', '/api/git/commit'], ['POST', '/api/git/branches'], ['DELETE', '/api/git/branches'],
  ['PUT', '/api/git/branches/rename'], ['DELETE', '/api/git/remote-branches'], ['POST', '/api/git/checkout'],
  ['POST', '/api/git/checkout-commit'], ['POST', '/api/git/cherry-pick'], ['POST', '/api/git/revert-commit'],
  ['POST', '/api/git/reset-to-commit'],
  ['GET', '/api/quota/credentials/exe-dev'], ['PUT', '/api/quota/credentials/exe-dev'],
  ['DELETE', '/api/quota/credentials/exe-dev'], ['POST', '/api/quota/credentials/exe-dev/validate'],
  ['POST', '/api/quota/credentials/cursor/import'], ['DELETE', '/api/provider/openai/auth'],
  // Last: before the removal this one stopped the server.
  ['POST', '/api/system/shutdown'],
];
const REMOVED_WS = ['/api/dev-tunnel?port=3000'];
// Kept sockets: the unclaimed-upgrade refusal must leave them to their owners.
const KEPT_WS = ['/api/global/event/ws', '/api/session/fixture-session/voice/socket'];

const probe = String.raw`
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { betterAuth } from 'better-auth';
import { testUtils } from 'better-auth/plugins';
const gatewaySeen = [];
const upstream = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url.includes('health')) return res.end('{"healthy":true}');
  gatewaySeen.push({ method: req.method, url: req.url, identity: Boolean(req.headers['x-smarty-human-identity']) });
  res.statusCode = 404;
  res.end('{"gatewayStub":"not found"}');
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
process.env.OPENCODE_HOST = 'http://127.0.0.1:' + upstream.address().port;
const originalFetch = globalThis.fetch;
let externalAttempts = 0;
globalThis.fetch = (input, options) => {
  const target = new URL(input instanceof Request ? input.url : String(input));
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
    externalAttempts++;
    return Promise.reject(new Error('Fixture refuses external network'));
  }
  return originalFetch(input, options);
};
const { createConfiguredHumanAuth } = await import(process.env.FIXTURE_HUMAN_CONFIG_URL);
const seedController = await createConfiguredHumanAuth(process.env);
const seed = betterAuth({ ...seedController.auth.options,
  user: { ...seedController.auth.options.user, validateUserInfo: undefined }, plugins: [testUtils()] });
const helpers = (await seed.$context).test;
const user = await helpers.saveUser(helpers.createUser({ email: 'person@example.test', emailVerified: true }));
const cookie = Object.fromEntries(await helpers.getAuthHeaders({ userId: user.id })).cookie;
const workdir = process.env.FIXTURE_WORKDIR;
let runtime;
const results = [];
const ORIGIN = 'https://code.smartypants.ai';
const call = (method, route, signedIn) => new Promise((resolve) => {
  const body = method === 'GET' ? null : JSON.stringify({ commands: ['touch exec-marker'], cwd: workdir, directory: workdir });
  const headers = { Host: 'code.smartypants.ai', Origin: ORIGIN, Connection: 'close' };
  if (signedIn) headers.Cookie = cookie;
  if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
  const before = gatewaySeen.length;
  const request = http.request({ host: '127.0.0.1', port: runtime.getPort(), method, path: route, headers }, res => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', chunk => { text += chunk; });
    res.on('end', () => resolve({ kind: 'http', method, route, signedIn, status: res.statusCode, body: text.slice(0, 160),
      reachedGateway: gatewaySeen.slice(before).some(row => row.method === method && route.startsWith('/api' + row.url.split('?')[0])) }));
  });
  request.setTimeout(8000, () => request.destroy(new Error('deadline')));
  request.on('error', error => resolve({ kind: 'http', method, route, signedIn, status: 'error:' + error.message }));
  if (body) request.write(body);
  request.end();
});
const upgrade = (route, signedIn) => new Promise((resolve) => {
  const headers = { Host: 'code.smartypants.ai', Origin: ORIGIN, Connection: 'Upgrade', Upgrade: 'websocket',
    'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' };
  if (signedIn) headers.Cookie = cookie;
  const request = http.request({ host: '127.0.0.1', port: runtime.getPort(), path: route, headers });
  const done = (outcome) => { resolve({ kind: 'ws', route, signedIn, outcome }); request.destroy(); };
  request.on('upgrade', (res, socket) => { socket.destroy(); done('upgraded:' + res.statusCode); });
  request.on('response', res => { res.resume(); done('rejected:' + res.statusCode); });
  request.on('error', error => done('closed:' + (error.code || error.message)));
  request.setTimeout(4000, () => done('no-answer'));
  request.end();
});
try {
  const { startWebUiServer } = await import(process.env.FIXTURE_INDEX_URL);
  runtime = await startWebUiServer({ port: 0, host: '127.0.0.1', attachSignals: false, exitOnShutdown: false, apiOnly: true });
  const record = (row) => { results.push(row); console.log('REMOVED_ROUTES_ROW=' + JSON.stringify(row)); };
  for (const [method, route] of JSON.parse(process.env.FIXTURE_HTTP)) {
    record(await call(method, route, false));
    record(await call(method, route, true));
  }
  for (const route of JSON.parse(process.env.FIXTURE_WS)) {
    results.push(await upgrade(route, false));
    results.push(await upgrade(route, true));
  }
  for (const route of JSON.parse(process.env.FIXTURE_KEPT_WS)) {
    results.push({ ...(await upgrade(route, true)), kind: 'kept-ws' });
  }
  results.push({ kind: 'alive', listening: runtime.httpServer.listening,
    execMarker: fs.existsSync(path.join(workdir, 'exec-marker')) });
} finally {
  if (runtime) await runtime.stop({ exitProcess: false });
  seedController.dispose();
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
}
console.log('REMOVED_ROUTES_RECEIPT=' + JSON.stringify({ results, externalAttempts }));
process.exit(0);
`;

let receipt;
beforeAll(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-removed-routes-'));
  fs.chmodSync(home, 0o700);
  const workdir = path.join(home, 'work');
  fs.mkdirSync(workdir);
  try {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', probe], {
      cwd: path.dirname(new URL('../../index.js', import.meta.url).pathname), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: '/usr/bin:/bin', HOME: home, TMPDIR: os.tmpdir(), NODE_ENV: 'test',
        XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
        XDG_STATE_HOME: path.join(home, '.local/state'), XDG_RUNTIME_DIR: home,
        OPENCHAMBER_DATA_DIR: path.join(home, 'data'), OPENCHAMBER_RELAY_HOST: 'off',
        OPENCHAMBER_HUMAN_AUTH: 'google', OPENCHAMBER_HUMAN_AUTH_DB: path.join(home, 'auth', 'auth.sqlite'),
        BETTER_AUTH_URL: 'https://code.smartypants.ai', BETTER_AUTH_SECRET: 'fixture-only-secret-at-least-thirty-two-characters',
        GOOGLE_CLIENT_ID: 'fixture-client', GOOGLE_CLIENT_SECRET: 'fixture-secret',
        SMARTY_HUMAN_AUTH_ALLOWED_DOMAINS: 'example.test', OPENCODE_SKIP_START: 'true',
        OPENCODE_SERVER_PASSWORD: 'fixture-gateway-bearer',
        OPENCHAMBER_ALLOWED_HOSTS: 'code.smartypants.ai',
        FIXTURE_INDEX_URL: new URL('../../index.js', import.meta.url).href,
        FIXTURE_HUMAN_CONFIG_URL: new URL('../ui-auth/human-auth-config.js', import.meta.url).href,
        FIXTURE_HTTP: JSON.stringify(REMOVED_HTTP), FIXTURE_WS: JSON.stringify(REMOVED_WS), FIXTURE_KEPT_WS: JSON.stringify(KEPT_WS), FIXTURE_WORKDIR: workdir,
      },
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const killGroup = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    const deadline = setTimeout(killGroup, 170000);
    try {
      const status = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      if (process.env.REMOVED_ROUTES_RECEIPT_FILE) fs.writeFileSync(process.env.REMOVED_ROUTES_RECEIPT_FILE + '.log', stdout + '\n--- stderr ---\n' + stderr);
      assert.equal(status, 0, stderr.slice(-4000));
    } finally { clearTimeout(deadline); killGroup(); }
    const line = stdout.split('\n').find(value => value.startsWith('REMOVED_ROUTES_RECEIPT='));
    if (process.env.REMOVED_ROUTES_RECEIPT_FILE) {
      // Rows stream as they happen, so a server that dies mid-probe still leaves its evidence.
      const rows = stdout.split('\n').filter(value => value.startsWith('REMOVED_ROUTES_ROW='))
        .map(value => JSON.parse(value.slice('REMOVED_ROUTES_ROW='.length)));
      fs.writeFileSync(process.env.REMOVED_ROUTES_RECEIPT_FILE, line ? line.slice('REMOVED_ROUTES_RECEIPT='.length)
        : JSON.stringify({ incomplete: true, rows }, null, 1));
    }
    assert.ok(line, 'the exported server must start and return a receipt');
    receipt = JSON.parse(line.slice('REMOVED_ROUTES_RECEIPT='.length));
    assert.equal(receipt.externalAttempts, 0);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}, 180000);

test('signed out, every removed route is refused at the API gate', () => {
  const rows = receipt.results.filter(row => row.kind === 'http' && !row.signedIn);
  assert.equal(rows.length, REMOVED_HTTP.length);
  for (const row of rows) assert.equal(row.status, 401, row.method + ' ' + row.route + ' ' + row.body);
});

test('signed in, no removed route is answered by OpenChamber: 404 from the gateway fall-through', () => {
  const rows = receipt.results.filter(row => row.kind === 'http' && row.signedIn);
  assert.equal(rows.length, REMOVED_HTTP.length);
  for (const row of rows) {
    assert.equal(row.status, 404, row.method + ' ' + row.route + ' ' + row.body);
    assert.deepEqual(JSON.parse(row.body), { gatewayStub: 'not found' }, row.method + ' ' + row.route);
    assert.equal(row.reachedGateway, true, row.method + ' ' + row.route);
  }
});

test('removed WebSocket endpoints are refused with 404, signed in or out', () => {
  const rows = receipt.results.filter(row => row.kind === 'ws');
  assert.equal(rows.length, REMOVED_WS.length * 2);
  for (const row of rows) assert.equal(row.outcome, 'rejected:404', row.route + ' signedIn=' + row.signedIn);
});

test('kept WebSocket endpoints still reach their own handlers', () => {
  const rows = receipt.results.filter(row => row.kind === 'kept-ws');
  assert.equal(rows.length, KEPT_WS.length);
  assert.equal(rows[0].outcome, 'upgraded:101', rows[0].route);
  // The voice socket answers for itself (no project directory here), never the 404 refusal.
  assert.equal(rows[1].outcome, 'rejected:400', rows[1].route);
});

test('nothing ran on the host and the server stayed up', () => {
  const alive = receipt.results.find(row => row.kind === 'alive');
  assert.equal(alive.listening, true);
  assert.equal(alive.execMarker, false);
});
