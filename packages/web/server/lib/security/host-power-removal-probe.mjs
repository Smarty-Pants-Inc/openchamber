import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

// Trust-boundary probe for the host-power routes removed in smarty-code#1398 slice 2.
// It records what the real exported server does with each removed route and
// prints a receipt; host-power-removal.test.js asserts the contract. The probe
// itself makes no pass/fail decision, so it can also record the tree before
// the removal (where a signed-in shutdown stops the server mid-run).
const source = process.env.HOST_POWER_PROBE_SOURCE || process.cwd();
const require = createRequire(source + '/packages/web/package.json');
const { betterAuth } = require('better-auth');
const { testUtils } = require('better-auth/plugins');
const { WebSocket } = require('ws');

const ROUTES = [
  ['POST', '/api/fs/exec'], ['GET', '/api/fs/exec/job-1'],
  ['GET', '/api/openchamber/update-check'], ['POST', '/api/openchamber/update-install'],
  ['GET', '/api/openchamber/tunnel/check'], ['GET', '/api/openchamber/tunnel/doctor'],
  ['POST', '/api/openchamber/tunnel/doctor'], ['GET', '/api/openchamber/tunnel/providers'],
  ['GET', '/api/openchamber/tunnel/status'], ['PUT', '/api/openchamber/tunnel/managed-remote-token'],
  ['POST', '/api/openchamber/tunnel/start'], ['POST', '/api/openchamber/tunnel/stop'],
  ['GET', '/api/openchamber/relay/status'], ['POST', '/api/openchamber/relay/enable'], ['POST', '/api/openchamber/relay/disable'],
  ['GET', '/api/dev-tunnel?port=3000'],
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
  // Last among canonical rows: before the removal, this one stopped the server.
  ['POST', '/api/system/shutdown'],
];
// Spellings that reach the same namespaces through Express's case-insensitive
// matching, percent-encoding (also past a malformed tail), repeated slashes,
// dot segments and backslashes.
const VARIANTS = [
  ['POST', '/API/Git/Push'], ['POST', '/api/%67it/%73tage'], ['POST', '/api//fs/exec'],
  ['GET', '/api/openchamber/%2574unnel/status'], ['POST', '/api/git/../git/commit'],
  ['DELETE', '/api/provider/%6fpenai/%61uth/x%zz'], ['GET', '/api/quota/credentials/x%E0%A4%A'],
  ['POST', '/api/system/./shutdown'],
];
const PROBE_ORIGIN_PACKAGED = 'capacitor://localhost';
const UPSTREAM_SENTINEL = 'UPSTREAM_SUCCESS_SENTINEL_HOSTPOWER';
const INDEX_SENTINEL = 'SERVED_INDEX_SENTINEL_HOSTPOWER';
// Tolerant decode for the recorder: a malformed escape never hides a retired request.
const looseDecode = value => {
  let current = value;
  for (let round = 0; round < 16; round += 1) {
    const next = current.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    if (next === current) break;
    current = next;
  }
  return current.replace(/\\/g, '/').toLowerCase();
};
const RETIRED_UPSTREAM = /(fs\/+exec|system\/+(\.\/)?shutdown|update-(check|install)|openchamber\/+(tunnel|relay)|dev-tunnel|(^|\/)git\/|quota\/+credentials|provider\/+[^/]+\/+auth)/;

const home = fs.mkdtempSync(path.join(process.env.TMPDIR, 'host-power-removed-'));
fs.chmodSync(home, 0o700);
const workdir = path.join(home, 'work');
fs.mkdirSync(workdir);
// A real repository, so the kept read routes answer with data rather than an error.
const git = (...args) => execFileSync('git', ['-C', workdir, ...args], { stdio: 'ignore', env: { PATH: process.env.PATH, HOME: home } });
git('init', '-q', '-b', 'main');
fs.writeFileSync(path.join(workdir, 'README.md'), 'fixture\n');
git('add', 'README.md');
git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '-m', 'fixture');
fs.writeFileSync(path.join(workdir, 'README.md'), 'fixture changed\n');
Object.assign(process.env, {
  HOME: home, XDG_CONFIG_HOME: home + '/config', XDG_DATA_HOME: home + '/share', XDG_STATE_HOME: home + '/state', XDG_RUNTIME_DIR: home,
  OPENCHAMBER_DATA_DIR: home + '/data', OPENCHAMBER_RELAY_HOST: 'off', OPENCODE_SKIP_START: 'true',
  // Server-owned upstream credential, as in production: a forward would carry it.
  OPENCODE_SERVER_PASSWORD: 'fixture-upstream-password',
  OPENCHAMBER_HUMAN_AUTH: 'google', OPENCHAMBER_HUMAN_AUTH_DB: home + '/auth.sqlite',
  BETTER_AUTH_URL: 'https://code.smartypants.ai', BETTER_AUTH_SECRET: 'private-fixture-only-thirty-two-character-secret',
  GOOGLE_CLIENT_ID: 'fixture-client', GOOGLE_CLIENT_SECRET: 'fixture-secret', SMARTY_HUMAN_AUTH_ALLOWED_DOMAINS: 'example.test',
  OPENCHAMBER_ALLOWED_HOSTS: 'code.smartypants.ai',
});
// Served-app mode with an identifiable index: a retired path must never fall back to it.
fs.mkdirSync(home + '/dist', { recursive: true });
fs.writeFileSync(home + '/dist/index.html', '<!doctype html><title>' + INDEX_SENTINEL + '</title>');
process.env.OPENCHAMBER_DIST_DIR = home + '/dist';
delete process.env.SMARTY_CODE_NODE_ID;
delete process.env.SMARTY_NODE_RECORD;

// The generic proxy forwards unknown API paths. This upstream answers every one
// with a conspicuous success, so an accidental forward can never pass as a
// refusal, and it records every retired-namespace request or upgrade it sees.
const upstreamRetired = [];
const upstream = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url.includes('health')) return res.end('{"healthy":true}');
  if (RETIRED_UPSTREAM.test(looseDecode(req.url))) upstreamRetired.push(req.method + ' ' + req.url + ' auth=' + Boolean(req.headers.authorization));
  res.writeHead(200); res.end(JSON.stringify({ sentinel: UPSTREAM_SENTINEL }));
});
upstream.on('upgrade', (req, socket) => {
  if (RETIRED_UPSTREAM.test(looseDecode(req.url))) upstreamRetired.push('UPGRADE ' + req.url);
  socket.destroy();
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
process.env.OPENCODE_HOST = 'http://127.0.0.1:' + upstream.address().port;
const originalFetch = globalThis.fetch;
let externalAttempts = 0;
globalThis.fetch = (input, options) => {
  const target = new URL(input instanceof Request ? input.url : String(input));
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
    externalAttempts++; return Promise.reject(new Error('Fixture refuses external network'));
  }
  return originalFetch(input, options);
};

const results = [];
const record = row => { results.push(row); console.log('HOST_POWER_ROW=' + JSON.stringify(row)); };
const sockets = new Set();
let runtime, human, firstUpgradeListener = 'none', registeredRetired = [];
// Raw HTTP so malformed request targets reach the server byte-for-byte.
const rawRequest = (port, method, route, headers, body) => new Promise(resolve => {
  const requestHeaders = { ...headers, Connection: 'close' };
  if (body) {
    requestHeaders['Content-Type'] = 'application/json';
    requestHeaders['Content-Length'] = Buffer.byteLength(body);
  }
  const request = http.request({ host: '127.0.0.1', port, method, path: route, headers: requestHeaders }, res => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', chunk => { text += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, body: text }));
  });
  request.setTimeout(8000, () => request.destroy(new Error('client deadline')));
  request.on('error', error => resolve({ status: 'error:' + (error.code || error.message), body: '' }));
  if (body) request.write(body);
  request.end();
});
// Raw upgrade: a server-written status followed by a server-initiated close. A
// client deadline is recorded as 'timeout', never as a refusal.
const rawUpgrade = (port, route, headers) => new Promise(resolve => {
  const socket = net.connect(port, '127.0.0.1');
  let data = '';
  const finish = outcome => { clearTimeout(deadline); socket.destroy(); resolve(outcome); };
  const deadline = setTimeout(() => finish({ status: 'timeout', closedByServer: false }), 3000);
  socket.setEncoding('latin1');
  socket.on('data', chunk => { data += chunk; });
  socket.on('error', () => {});
  socket.once('close', () => finish({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1]) || 'no-status', closedByServer: true }));
  socket.once('connect', () => {
    const all = { ...headers, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' };
    socket.write('GET ' + route + ' HTTP/1.1\r\n' + Object.entries(all).map(([key, value]) => key + ': ' + value + '\r\n').join('') + '\r\n');
  });
});
try {
  const { createConfiguredHumanAuth } = await import(source + '/packages/web/server/lib/ui-auth/human-auth-config.js');
  human = await createConfiguredHumanAuth(process.env);
  const seed = betterAuth({ ...human.auth.options, user: { ...human.auth.options.user, validateUserInfo: undefined }, plugins: [testUtils()] });
  const helpers = (await seed.$context).test;
  const user = await helpers.saveUser(helpers.createUser({ email: 'fixture@example.test', emailVerified: true }));
  const signedIn = Object.fromEntries(await helpers.getAuthHeaders({ userId: user.id }));
  const { startWebUiServer } = await import(source + '/packages/web/server/index.js');
  runtime = await startWebUiServer({ port: 0, host: '127.0.0.1', attachSignals: false, exitOnShutdown: false, apiOnly: false });
  runtime.httpServer.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const port = runtime.getPort();
  const app = runtime.httpServer.listeners('request')[0];
  // No removed route may still be registered with any handler.
  for (const [method, route] of ROUTES) {
    const pathname = route.split('?')[0];
    for (const layer of app.router.stack) {
      if (layer.route && layer.match(pathname) && layer.route._handlesMethod?.(method)) registeredRetired.push(method + ' ' + pathname);
    }
  }
  firstUpgradeListener = runtime.httpServer.listeners('upgrade')[0]?.name || 'none';
  const appHeaders = auth => ({ Host: 'code.smartypants.ai', Origin: 'https://code.smartypants.ai', ...auth });
  const body = JSON.stringify({ commands: ['touch exec-marker'], cwd: workdir, directory: workdir, path: workdir });
  const index = await rawRequest(port, 'GET', '/', appHeaders({}));
  record({ label: 'control', method: 'GET', route: '/', status: index.status, indexServed: index.body.includes(INDEX_SENTINEL) });
  for (const [label, auth] of [['signed-out', {}], ['signed-in', signedIn]]) {
    if (label === 'signed-in') {
      const settings = await rawRequest(port, 'GET', '/api/config/settings', appHeaders(auth));
      record({ label, method: 'CONTROL', route: '/api/config/settings', status: settings.status });
    }
    for (const [method, route] of [...ROUTES, ...VARIANTS]) {
      if (!runtime.httpServer.listening) { record({ label, method, route, status: 'server-stopped' }); continue; }
      const res = await rawRequest(port, method, route, appHeaders(auth), method === 'GET' || method === 'DELETE' ? null : body);
      const leaked = res.body.includes(UPSTREAM_SENTINEL) || res.body.includes(INDEX_SENTINEL);
      record({ label, method, route, status: res.status, leaked, variant: !ROUTES.some(([, known]) => known === route), body: res.body.slice(0, 120) });
    }
    // Every former path must also refuse an upgrade itself and close the raw socket.
    // In parallel, so unowned sockets that never answer cost one client deadline in total.
    const upgradeRoutes = [...ROUTES, ...VARIANTS].map(([, route]) => route);
    const outcomes = await Promise.all(upgradeRoutes.map(route => rawUpgrade(port, route, appHeaders(auth))));
    for (const [index, route] of upgradeRoutes.entries()) {
      record({ label, method: 'WS', route, ...outcomes[index], variant: !ROUTES.some(([, known]) => known === route) });
    }
    // A packaged client's CORS preflight for a removed route is refused, not answered 204.
    for (const [method, route] of ROUTES) {
      const res = await rawRequest(port, 'OPTIONS', route, { ...appHeaders(auth), Origin: PROBE_ORIGIN_PACKAGED, 'Access-Control-Request-Method': method });
      record({ label, method: 'PREFLIGHT', requested: method, route, status: res.status, leaked: res.body.includes(UPSTREAM_SENTINEL) || res.body.includes(INDEX_SENTINEL) });
    }
    // Kept controls: the read-only git routes the Git view uses, their preflight, and the remaining sockets.
    for (const route of ['/api/git/status', '/api/git/diff', '/api/git/log', '/api/git/branches']) {
      const res = await rawRequest(port, 'GET', route + '?directory=' + encodeURIComponent(workdir) + '&path=README.md', appHeaders(auth));
      record({ label, method: 'KEPT', route, status: res.status, leaked: res.body.includes(UPSTREAM_SENTINEL) || res.body.includes(INDEX_SENTINEL) });
    }
    const keptPreflight = await rawRequest(port, 'OPTIONS', '/api/git/branches', { ...appHeaders(auth), Origin: PROBE_ORIGIN_PACKAGED, 'Access-Control-Request-Method': 'GET' });
    record({ label, method: 'KEPT-PREFLIGHT', route: '/api/git/branches', status: keptPreflight.status });
    const control = await new Promise(resolve => {
      const socket = new WebSocket('ws://127.0.0.1:' + port + '/api/global/event/ws', { headers: appHeaders(auth), handshakeTimeout: 3000 });
      socket.once('open', () => { socket.terminate(); resolve(101); });
      socket.once('unexpected-response', (_req, res) => { res.resume(); socket.terminate(); resolve(res.statusCode); });
      socket.on('error', error => resolve('error:' + error.message));
    });
    record({ label, method: 'CONTROL-WS', route: '/api/global/event/ws', status: control });
    const voice = await rawUpgrade(port, '/api/session/fixture-session/voice/socket', appHeaders(auth));
    record({ label, method: 'CONTROL-VOICE', route: '/api/session/fixture-session/voice/socket', ...voice });
  }
} finally {
  const listening = Boolean(runtime?.httpServer?.listening);
  const execMarker = fs.existsSync(path.join(workdir, 'exec-marker'));
  for (const socket of sockets) socket.destroy();
  try { await runtime?.stop({ exitProcess: false }); } catch { /* already stopped by a removed route */ }
  human?.dispose();
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  fs.rmSync(home, { recursive: true, force: true });
  console.log('HOST_POWER_RECEIPT=' + JSON.stringify({ results, listening, execMarker, externalAttempts, upstreamRetired, firstUpgradeListener, registeredRetired }));
}
process.exit(0);
