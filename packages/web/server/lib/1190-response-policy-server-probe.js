import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { betterAuth } from 'better-auth';
import { testUtils } from 'better-auth/plugins';
import { assertAuthGetSession } from './1190-response-policy-auth-get-probe.js';
// Run in a dedicated Node process. This exercises the exported owning server,
// not a browser, Google exchange, Code policy or security acceptance candidate.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oc1190-'));
fs.chmodSync(home, 0o700);
const dist = path.join(home, 'dist');
fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
const html = '<!doctype html><script src="https://policy-fixture.invalid/inert.js"></script>';
for (const name of ['index.html', 'mobile.html', 'mini-chat.html']) fs.writeFileSync(path.join(dist, name), html);
fs.writeFileSync(path.join(dist, 'sw.js'), '/* inert worker */');
fs.writeFileSync(path.join(dist, 'assets/inert.js'), '/* inert local asset */');
Object.assign(process.env, {
  HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'share'),
  XDG_STATE_HOME: path.join(home, 'state'), XDG_RUNTIME_DIR: home,
  OPENCHAMBER_DATA_DIR: path.join(home, 'data'), OPENCHAMBER_DIST_DIR: dist,
  OPENCHAMBER_RELAY_HOST: 'off', OPENCODE_SKIP_START: 'true',
  OPENCHAMBER_HUMAN_AUTH: 'google', OPENCHAMBER_HUMAN_AUTH_DB: path.join(home, 'auth.sqlite'),
  BETTER_AUTH_URL: 'https://code.smartypants.ai', BETTER_AUTH_SECRET: 'private-fixture-only-thirty-two-character-secret',
  GOOGLE_CLIENT_ID: 'fixture-client', GOOGLE_CLIENT_SECRET: 'fixture-secret',
  SMARTY_HUMAN_AUTH_ALLOWED_DOMAINS: 'example.test', OPENCHAMBER_ALLOWED_HOSTS: 'code.smartypants.ai',
});
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
const upstream = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(req.url.includes('health') ? '{"healthy":true}' : '[]');
});
let runtime, seedController, helpers, user, sessionA, sessionB, startWebUiServer, policyVersion;
let mode = async () => [['Content-Security-Policy', "script-src 'none'"], ['Cache-Control', 'private, no-store'], ['Vary', 'Cookie']];
let calls = 0;
const policy = (req, context) => { calls++; return mode(req, context); };
const call = (route, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: runtime.getPort(), path: route, method,
    headers: { Host: 'code.smartypants.ai', Connection: 'close', ...headers } }, res => {
    let body = '';
    res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.setTimeout(7000, () => req.destroy(new Error('Fixture request deadline')));
  req.on('error', reject); req.end();
});

before(async () => {
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  process.env.OPENCODE_HOST = `http://127.0.0.1:${upstream.address().port}`;
  const { createConfiguredHumanAuth } = await import('./ui-auth/human-auth-config.js');
  seedController = await createConfiguredHumanAuth(process.env);
  const seed = betterAuth({ ...seedController.auth.options,
    user: { ...seedController.auth.options.user, validateUserInfo: undefined }, plugins: [testUtils()] });
  helpers = (await seed.$context).test;
  user = await helpers.saveUser(helpers.createUser({ email: 'fixture@example.test', emailVerified: true }));
  const person = async () => {
    const headers = Object.fromEntries(await helpers.getAuthHeaders({ userId: user.id }));
    const resolved = await seedController.resolve({ headers });
    return { cookie: headers.cookie, session: resolved.session };
  };
  sessionA = await person(); sessionB = await person();
  ({ startWebUiServer, HTTP_RESPONSE_POLICY_VERSION: policyVersion } = await import('../index.js'));
  runtime = await startWebUiServer({ port: 0, host: '127.0.0.1', attachSignals: false,
    exitOnShutdown: false, responsePolicy: policy });
  assert.equal(runtime.httpServer.listening, true);
}, { timeout: 30000 });

after(async () => {
  if (runtime) {
    await runtime.stop({ exitProcess: false });
    if (runtime.httpServer.listening) { runtime.httpServer.closeAllConnections(); await new Promise(resolve => runtime.httpServer.close(resolve)); }
    assert.equal(runtime.httpServer.listening, false);
  }
  seedController?.dispose();
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  globalThis.fetch = originalFetch;
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(externalAttempts, 0, 'No external provider or account requests');
  console.log('1190 generic server probe stopped; owned listener and upstream closed');
});
test('public generic HTTP policy capability is exported only with actual early option wiring', () => {
  assert.equal(policyVersion, 1);
});
test('optional hook reaches real bootstrap/static routes before bytes including external-script HTML', async () => {
  for (const route of ['/', '/index.html', '/mobile.html', '/mini-chat.html', '/sw.js', '/sessions/inert',
    '/assets/inert.js', '/assets/missing.js', '/manifest.webmanifest', '/robots.txt', '/health']) {
    const result = await call(route);
    assert.equal(result.status, route === '/assets/missing.js' ? 404 : 200);
    assert.equal(result.headers['content-security-policy'], "script-src 'none'", route);
    assert.equal(result.headers['cache-control'], 'private, no-store', route);
    assert.ok(result.headers.vary.split(/,\s*/).includes('Cookie'), route);
    if (['/', '/index.html', '/mobile.html', '/mini-chat.html', '/sessions/inert'].includes(route)) assert.equal(result.body, html);
  }
});

test('existing human Host authority precedes policy and native preflight preserves Vary', async () => {
  const beforeCalls = calls;
  const denied = await call('/robots.txt', { Host: 'unbound.example.test', 'X-Forwarded-Host': 'code.smartypants.ai' });
  assert.equal(denied.status, 403); assert.equal(calls, beforeCalls);
  const result = await call('/api/fs/write', { Origin: 'openchamber-ui://app' }, 'OPTIONS');
  assert.equal(result.status, 204); assert.equal(result.headers['access-control-allow-origin'], 'openchamber-ui://app');
  assert.ok(result.headers.vary.split(/,\s*/).includes('Cookie'));
  assert.ok(result.headers.vary.split(/,\s*/).includes('Origin'));
});

test('real sessions return only specific sanitized metadata and memoize accessor per request', async () => {
  const observations = [];
  mode = async (_req, context) => {
    const first = context.getHumanSession(), second = context.getHumanSession();
    assert.equal(first, second);
    const value = await first; observations.push(value);
    if (value) { assert.ok(Object.isFrozen(value)); assert.deepEqual(Object.keys(value).sort(), ['createdAt', 'expiresAt', 'id']); }
    return [['X-Policy-Fixture', value ? 'human' : 'anonymous'], ['Cache-Control', 'private, no-store']];
  };
  for (const person of [sessionA, sessionB]) {
    const result = await call('/', { Cookie: person.cookie });
    assert.equal(result.headers['x-policy-fixture'], 'human');
    const value = observations.at(-1);
    assert.equal(value.id, person.session.id);
    assert.equal(value.createdAt, new Date(person.session.createdAt).getTime());
    assert.equal(value.expiresAt, new Date(person.session.expiresAt).getTime());
    await assertAuthGetSession(call, person, () => observations.at(-1));
  }
  assert.notEqual(sessionA.session.id, sessionB.session.id);
  for (const headers of [{}, { Cookie: 'better-auth.session_token=invalid' }, { 'X-Smarty-Human-Actor': 'spoofed' },
    { Cookie: sessionA.cookie, Authorization: 'Bearer inert-device' }]) {
    assert.equal((await call('/', headers)).headers['x-policy-fixture'], 'anonymous');
    assert.equal(observations.at(-1), null);
  }
});

test('invalid result and rejected callback produce sanitized 503 before static content', async () => {
  for (const handler of [() => [['X-Early', 'must-not-be-written'], ['Invalid Header', 'value']],
    () => { throw new Error('private failure detail'); }]) {
    mode = handler;
    const result = await call('/');
    assert.equal(result.status, 503);
    assert.deepEqual(JSON.parse(result.body), { error: 'Response policy unavailable' });
    assert.equal(result.headers['x-early'], undefined); assert.equal(result.headers['content-security-policy'], undefined);
    assert.ok(!result.body.includes('private failure detail'));
  }
});

test('hung callback has one five-second deadline and cannot continue into static routes', async () => {
  let signal, release;
  mode = (_req, context) => { signal = context.signal; return new Promise(resolve => { release = resolve; }); };
  const started = Date.now(), result = await call('/');
  assert.equal(result.status, 503); assert.ok(Date.now() - started < 6500);
  assert.ok(signal.aborted); release([['X-Late', 'forbidden']]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.headers['x-late'], undefined);
}, { timeout: 8000 });

test('concurrent held callbacks on the real server close with zero late headers or downstream bytes', async () => {
  const held = [], responses = [], requests = [];
  let entered;
  const both = new Promise(resolve => { entered = resolve; });
  mode = (_req, context) => new Promise(resolve => { held.push({ context, release: resolve }); if (held.length === 2) entered(); });
  const observe = (_req, res) => responses.push(res);
  runtime.httpServer.prependListener('request', observe);
  let deadline;
  try {
    for (let index = 0; index < 2; index++) {
      const req = http.get({ host: '127.0.0.1', port: runtime.getPort(), path: '/', headers: { Host: 'code.smartypants.ai' } });
      req.on('response', res => res.resume()); req.on('error', () => {}); requests.push(req);
    }
    await Promise.race([both, new Promise(resolve => { deadline = setTimeout(resolve, 2000); })]);
    assert.equal(held.length, 2, 'Both actual requests must enter the hook before static handling');
    const closed = responses.map(res => once(res, 'close'));
    requests.forEach(req => req.destroy()); await Promise.all(closed);
    for (const pending of held) { assert.ok(pending.context.signal.aborted); pending.release([['X-Late', 'forbidden']]); }
    await new Promise(resolve => setImmediate(resolve));
    for (const res of responses) { assert.equal(res.getHeader('X-Late'), undefined); assert.equal(res.headersSent, false); }
  } finally {
    clearTimeout(deadline); runtime.httpServer.off('request', observe);
    requests.forEach(req => req.destroy()); held.forEach(pending => pending.release([]));
  }
});

test('invalid startup hook is rejected rather than ignored', async () => {
  let unexpected, error;
  try { unexpected = await startWebUiServer({ port: 0, host: '127.0.0.1', attachSignals: false, exitOnShutdown: false, responsePolicy: {} }); }
  catch (caught) { error = caught; }
  finally { if (unexpected) await unexpected.stop({ exitProcess: false }); }
  assert.match(error?.message ?? '', /responsePolicy must be a function/);
});
