import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, test } from 'vitest';
import { record } from '../ui-auth/human-member-fixture.js';

/** The real exported server in Node mode, in its own process (index.js keeps import-time singletons). After startup the
 *  probe walks every route and router Express registered, checks the member allow-list is mounted before all of them,
 *  and sends each route that is not on the allow-list one request: it must get the member refusal. A route added later
 *  without an allow-list entry fails here; that is the point. */
const probe = `
import http from 'node:http';
const upstream = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json');
  res.end(req.url.includes('health') ? '{"healthy":true}' : '[]'); });
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
process.env.OPENCODE_HOST = 'http://127.0.0.1:' + upstream.address().port;
const { memberAllowList, memberRequestAllowed } = await import(process.env.FIXTURE_GATE_URL);
const { startWebUiServer } = await import(process.env.FIXTURE_INDEX_URL);
const runtime = await startWebUiServer({ port: 0, host: '127.0.0.1', attachSignals: false, exitOnShutdown: false, apiOnly: true });
const app = runtime.httpServer.listeners('request').find(listener => listener.router);
const routes = [], layers = [];
const walk = (stack, prefix) => stack.forEach(layer => {
  layers.push(layer);
  if (layer.route) {
    const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
    for (const route of paths) for (const method of Object.keys(layer.route.methods)) {
      if (method !== '_all') routes.push({ method: method.toUpperCase(), path: route, index: layers.length - 1 });
      else for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) routes.push({ method: m, path: route, index: layers.length - 1 });
    }
  } else if (layer.handle?.stack) walk(layer.handle.stack, prefix);
});
walk(app.router.stack, '');
const gateIndex = layers.findIndex(layer => layer.handle === memberAllowList);
const concrete = route => typeof route !== 'string' ? null
  : route.replace(/:[A-Za-z_]+\\??/g, 'x').replace(/\\*[A-Za-z_]+/g, 'x').replace(/[{}]/g, '');
const call = (method, route) => new Promise((resolve, reject) => {
  const request = http.request({ host: '127.0.0.1', port: runtime.getPort(), method, path: route,
    headers: { Host: 'code.smartypants.ai', Origin: 'https://code.smartypants.ai', Connection: 'close',
      'Content-Type': 'application/json' } }, res => {
    let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  request.setTimeout(3000, () => request.destroy(new Error('deadline ' + method + ' ' + route)));
  request.on('error', reject);
  request.end(['GET', 'HEAD', 'DELETE'].includes(method) ? undefined : '{}');
});
const checked = [], uncheckable = [], beforeGate = [];
try {
  for (const route of routes) {
    // A route before the gate is fine only if the gate would pass it anyway (the static robots.txt read).
    if (route.index < gateIndex && !memberRequestAllowed(route.method, String(route.path))) beforeGate.push(route.method + ' ' + String(route.path));
    const target = concrete(route.path);
    if (target === null) {
      uncheckable.push(route.method + ' ' + String(route.path));
      // Pattern routes: probe one concrete path each; the gate decides on the path, so one sample per route suffices.
      const sample = String(route.path).includes('fs\\\\/serve') ? '/api/fs/serve/x' : null;
      if (sample && !memberRequestAllowed(route.method, sample)) {
        const result = await call(route.method, sample);
        checked.push({ method: route.method, path: sample, status: result.status, body: result.body.slice(0, 200) });
      }
      continue;
    }
    if (memberRequestAllowed(route.method, target)) continue;
    const result = await call(route.method, target);
    checked.push({ method: route.method, path: target, status: result.status, body: result.body.slice(0, 200) });
  }
} finally {
  await runtime.stop({ exitProcess: false });
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
}
console.log('ROUTE_WALK_RECEIPT=' + JSON.stringify({ routeCount: routes.length, gateIndex, beforeGate, uncheckable, checked }));
process.exit(0);
`;

let receipt;
beforeAll(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-route-walk-'));
  fs.chmodSync(home, 0o700);
  try {
    const recordPath = path.join(home, 'registry.json');
    fs.writeFileSync(recordPath, JSON.stringify(record()));
    const child = spawn(process.execPath, ['--input-type=module', '--eval', probe], {
      cwd: home, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: '/usr/bin:/bin', HOME: home, TMPDIR: os.tmpdir(), NODE_ENV: 'test',
        XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
        XDG_STATE_HOME: path.join(home, '.local/state'), XDG_RUNTIME_DIR: home,
        OPENCHAMBER_DATA_DIR: path.join(home, 'data'), OPENCHAMBER_RELAY_HOST: 'off',
        OPENCHAMBER_HUMAN_AUTH: 'google', OPENCHAMBER_HUMAN_AUTH_DB: path.join(home, 'auth.sqlite'),
        BETTER_AUTH_URL: 'https://code.smartypants.ai', BETTER_AUTH_SECRET: 'fixture-only-secret-at-least-thirty-two-characters',
        GOOGLE_CLIENT_ID: 'fixture-client', GOOGLE_CLIENT_SECRET: 'fixture-secret',
        SMARTY_HUMAN_AUTH_ALLOWED_DOMAINS: 'example.test', OPENCODE_SKIP_START: 'true',
        OPENCHAMBER_ALLOWED_HOSTS: 'code.smartypants.ai',
        SMARTY_CODE_NODE_ID: 'test-node', SMARTY_NODE_RECORD: recordPath, SMARTY_NODE_ORG_ID: 'test-org',
        FIXTURE_INDEX_URL: new URL('../../index.js', import.meta.url).href,
        FIXTURE_GATE_URL: new URL('./node-member-agent-access.js', import.meta.url).href,
      },
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const killGroup = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    const deadline = setTimeout(killGroup, 100000);
    try {
      const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      assert.equal(status, 0, stderr.slice(-4000));
    } finally { clearTimeout(deadline); killGroup(); }
    const line = stdout.split('\n').find(value => value.startsWith('ROUTE_WALK_RECEIPT='));
    assert.ok(line, 'startup must finish and return the route walk');
    receipt = JSON.parse(line.slice('ROUTE_WALK_RECEIPT='.length));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}, 120000);

test('Node mode: the member allow-list is mounted before every registered route and router', () => {
  assert.ok(receipt.routeCount > 100, `walked ${receipt.routeCount} routes`);
  assert.ok(receipt.gateIndex >= 0, 'the allow-list layer is registered');
  assert.deepEqual(receipt.beforeGate, []);
});

test('Node mode: every registered route off the allow-list refuses a member', () => {
  const refused = JSON.stringify({ error: 'members have read-only access until isolation, smarty-code#1442', code: 'NODE_MEMBER_READ_ONLY' });
  const leaks = receipt.checked.filter(row => row.status !== 403 || row.body !== refused);
  assert.deepEqual(leaks, []);
  assert.ok(receipt.checked.length > 100, `checked ${receipt.checked.length} routes`);
});

test('Node mode: pattern routes are exactly the preview capability, the file serve route and the UI shell', () => {
  assert.equal(receipt.uncheckable.length, 3, JSON.stringify(receipt.uncheckable));
  assert.ok(receipt.uncheckable.some(route => route.includes('fs\\/preview')));
  assert.ok(receipt.uncheckable.some(route => route.startsWith('GET /^(?!\\/api')));
  // The serve route is probed with a concrete path above and must be refused.
  assert.ok(receipt.checked.some(row => row.path === '/api/fs/serve/x' && row.status === 403));
});
