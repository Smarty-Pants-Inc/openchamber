import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, test } from 'vitest';

// A separate process isolates index.js import-time HOME paths and singleton runtimes.
// No copied route registrations, production permission mocks, or Google exchanges.
const probe = `
import http from 'node:http';
import assert from 'node:assert/strict';
const upstream = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(req.url.includes('health') ? '{"healthy":true}' : '[]');
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
let runtime;
const results = [];
const call = (method, route, host, origin, forwarded = false) => new Promise((resolve, reject) => {
  const headers = { Host: host, Connection: 'close' };
  if (origin) headers.Origin = origin;
  if (forwarded) {
    headers['X-Forwarded-Host'] = 'code.smartypants.ai';
    headers.Forwarded = 'host=code.smartypants.ai;proto=https';
  }
  const request = http.request({ host: '127.0.0.1', port: runtime.getPort(), method, path: route, headers }, res => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', chunk => { body += chunk; });
    res.on('end', () => resolve({ method, route, host, origin, forwarded, status: res.statusCode, headers: res.headers, body }));
  });
  request.setTimeout(3000, () => request.destroy(new Error('Fixture HTTP deadline')));
  request.on('error', reject);
  request.end();
});
try {
  const { startWebUiServer } = await import(process.env.FIXTURE_INDEX_URL);
  runtime = await startWebUiServer({ port: 0, host: '127.0.0.1', attachSignals: false, exitOnShutdown: false, apiOnly: true });
  assert.equal(runtime.httpServer.listening, true);
  for (const forwarded of [false, true]) {
    results.push(await call('GET', '/robots.txt', 'test-org.smartypants.ai', undefined, forwarded));
    results.push(await call('OPTIONS', '/api/fs/write', 'test-org.smartypants.ai', 'openchamber-ui://app', forwarded));
  }
  const hosts = ['code.smartypants.ai', 'smartypants.smartypants.ai', 'localhost:4001', '127.0.0.1:4001', '[::1]:4001'];
  const origins = ['openchamber-ui://app', 'capacitor://localhost', 'http://localhost', 'https://localhost',
    'http://localhost:4001', 'https://127.0.0.1:4001'];
  for (const host of hosts) {
    results.push(await call('GET', '/robots.txt', host));
    results.push(await call('GET', '/health', host, 'https://code.smartypants.ai'));
    for (const origin of origins) results.push(await call('OPTIONS', '/api/fs/write', host, origin));
  }
  for (const origin of ['https://code.smartypants.ai', 'https://smartypants.smartypants.ai', 'null', 'https://attacker.test', 'openchamber-ui://app']) {
    results.push(await call('POST', '/api/fs/write', 'code.smartypants.ai', origin));
  }
  results.push(await call('GET', '/api/config/settings', 'code.smartypants.ai', 'https://code.smartypants.ai'));
  results.push(await call('OPTIONS', '/api/fs/write', 'code.smartypants.ai', 'https://code.smartypants.ai'));
} finally {
  if (runtime) {
    await runtime.stop({ exitProcess: false });
    assert.equal(runtime.httpServer.listening, false);
  }
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
}
console.log('INDEX_HOST_RECEIPT=' + JSON.stringify({ results, externalAttempts, stopped: true }));
process.exit(0);
`;

let receipt;
beforeAll(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-index-host-'));
  fs.chmodSync(home, 0o700);
  try {
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
        OPENCHAMBER_ALLOWED_HOSTS: 'code.smartypants.ai,smartypants.smartypants.ai',
        FIXTURE_INDEX_URL: new URL('../../index.js', import.meta.url).href,
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
    const deadline = setTimeout(killGroup, 45000);
    try {
      const status = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      console.log(stdout);
      assert.equal(status, 0, stderr);
    } finally { clearTimeout(deadline); killGroup(); }
    const line = stdout.split('\n').find(value => value.startsWith('INDEX_HOST_RECEIPT='));
    assert.ok(line, 'exported startup must finish and return a behavioral receipt');
    receipt = JSON.parse(line.slice('INDEX_HOST_RECEIPT='.length));
    assert.equal(receipt.externalAttempts, 0);
    assert.equal(receipt.stopped, true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}, 60000);

test('exported index startup refuses unbound robots requests, ignoring forwarded Host', () => {
  for (const result of receipt.results.filter(row => row.host === 'test-org.smartypants.ai' && row.method === 'GET')) {
    assert.equal(result.status, 403);
    assert.deepEqual(JSON.parse(result.body), { error: 'Requests require an application host' });
  }
});

test('exported index startup refuses unbound native preflight before CORS', () => {
  for (const result of receipt.results.filter(row => row.host === 'test-org.smartypants.ai' && row.method === 'OPTIONS')) {
    assert.equal(result.status, 403);
    assert.deepEqual(JSON.parse(result.body), { error: 'Requests require an application host' });
    assert.equal(result.headers['access-control-allow-origin'], undefined);
  }
});

test('actual startup configures both aliases and loopback before early responses', () => {
  for (const result of receipt.results.filter(row => row.host !== 'test-org.smartypants.ai' && row.method === 'GET')) {
    assert.equal(result.status, result.route === '/api/config/settings' ? 401 : 200);
    if (result.route === '/robots.txt') assert.equal(result.body, 'User-agent: *\nDisallow: /\n');
  }
});

test('bound native preflight retains CORS 204 without granting human API access', () => {
  for (const result of receipt.results.filter(row => row.host !== 'test-org.smartypants.ai' && row.method === 'OPTIONS' && row.origin !== 'https://code.smartypants.ai')) {
    assert.equal(result.status, 204);
    assert.equal(result.headers['access-control-allow-origin'], result.origin);
    assert.equal(result.headers['access-control-allow-credentials'], 'true');
  }
  for (const result of receipt.results.filter(row => row.method === 'POST')) {
    assert.equal(result.status, result.origin === 'https://code.smartypants.ai' ? 401 : 403);
    if (result.status === 403) assert.deepEqual(JSON.parse(result.body), { error: 'Human authentication requires the configured application origin' });
  }
  const issuerPreflight = receipt.results.find(row => row.method === 'OPTIONS' && row.origin === 'https://code.smartypants.ai');
  assert.equal(issuerPreflight.status, 401);
  assert.equal(issuerPreflight.headers['access-control-allow-origin'], undefined);
});
