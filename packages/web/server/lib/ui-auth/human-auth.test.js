import assert from 'node:assert/strict';
import { test } from 'vitest';
import { EventEmitter } from 'node:events';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { betterAuth } from 'better-auth';
import { testUtils } from 'better-auth/plugins';
import { createHumanAuth, safeAppReturn } from './human-auth.js';

const config = { baseURL: 'http://localhost:43210', secret: 'fixture-only-secret-at-least-thirty-two-characters',
  googleClientId: 'fixture-google-client', googleClientSecret: 'fixture-google-secret', allowedDomains: ['example.test'] };
const request = (headers) => ({ headers: Object.fromEntries(headers) });

async function fixture() {
  const database = new DatabaseSync(':memory:');
  const human = await createHumanAuth({ ...config, database });
  // Privileged official fixture helpers never appear in production options.
  // Seed session-only fixtures without an OAuth endpoint; callback tests use the full production gate.
  const testAuth = betterAuth({ ...human.auth.options,
    user: { ...human.auth.options.user, validateUserInfo: undefined }, plugins: [testUtils()] });
  const helpers = (await testAuth.$context).test;
  const user = await helpers.saveUser(helpers.createUser({ name: 'Person', email: 'person@example.test', emailVerified: true }));
  return { database, human, helpers, user, close: () => { human.dispose(); database.close(); } };
}

test('real Better Auth sessions keep one person across devices and editable profile', async () => {
  const f = await fixture();
  try {
    const a = await f.helpers.getAuthHeaders({ userId: f.user.id });
    const b = await f.helpers.getAuthHeaders({ userId: f.user.id });
    const first = await f.human.resolve(request(a));
    const second = await f.human.resolve(request(b));
    assert.equal(first.user.id, second.user.id);
    assert.notEqual(first.session.id, second.session.id);
    assert.equal(Object.hasOwn(f.human.actor(first), 'image'), false);
    assert.equal(Object.hasOwn(f.human.actor({ ...first,
      user: { ...first.user, image: 'javascript:alert(1)' } }), 'image'), false);
    await f.human.auth.api.updateUser({ headers: a, body: { name: 'New Name', image: 'https://example.test/photo' } });
    const updated = await f.human.resolve(request(b));
    assert.equal(updated.user.id, first.user.id);
    assert.equal(updated.user.name, 'New Name');
    assert.equal(f.human.actor(updated).image, 'https://example.test/photo');
    // smarty-code#701: the admitted (verified) email names the person's inbox at the gateway.
    assert.equal(f.human.actor(first).email, 'person@example.test');
    assert.equal(await f.human.resolve({ headers: {} }), null);
    assert.equal(await f.human.resolve({ headers: { ...Object.fromEntries(a), authorization: 'Bearer old-device' } }), null);
  } finally { f.close(); }
});

test('revocation closes an admitted response and denies the revoked device on the next request', async () => {
  const f = await fixture();
  try {
    const a = await f.helpers.getAuthHeaders({ userId: f.user.id });
    const b = await f.helpers.getAuthHeaders({ userId: f.user.id });
    const response = new EventEmitter();
    let destroyed = false, admitted = false;
    response.destroy = () => { destroyed = true; response.emit('close'); };
    await f.human.protect(request(b), response, () => { admitted = true; });
    assert.equal(admitted, true);
    await f.human.auth.api.revokeOtherSessions({ headers: a });
    assert.equal(destroyed, true);
    assert.equal(await f.human.resolve(request(b)), null);
    assert.ok(await f.human.resolve(request(a)));
    await f.human.auth.api.signOut({ headers: a });
    assert.equal(await f.human.resolve(request(a)), null);
  } finally { f.close(); }
});

test('revocation between session lookup and response registration cannot admit or keep a stream', async () => {
  const f = await fixture();
  try {
    for (const heldRead of [1, 2]) for (const operation of ['signOut', 'revokeSessions']) {
      const headers = await f.helpers.getAuthHeaders({ userId: f.user.id });
      const original = f.human.auth.api.getSession;
      let release, sampled;
      const pause = new Promise(resolve => { release = resolve; });
      const read = new Promise(resolve => { sampled = resolve; });
      let reads = 0;
      f.human.auth.api.getSession = async (...args) => {
        const session = await original(...args);
        if (++reads === heldRead) { sampled(); await pause; }
        return session;
      };
      // Real Node destroy marks destroyed before the asynchronous close event.
      const response = new ServerResponse(new IncomingMessage(new Socket()));
      let admitted = false;
      const pending = f.human.protect(request(headers), response, () => { admitted = true; });
      await read;
      await f.human.auth.api[operation]({ headers });
      release(); await pending;
      assert.equal(admitted, false);
      assert.equal(response.destroyed, true);
      assert.equal(await original({ headers }), null);
      f.human.auth.api.getSession = original;
    }
  } finally { f.close(); }
});

test('the same session lifecycle guards raw upgrade sockets and uses a transport-specific refusal', async () => {
  const f = await fixture();
  try {
    const denied = new Socket();
    let refused = false;
    await f.human.protect({ headers: {} }, denied, () => assert.fail('anonymous upgrade admitted'), socket => {
      refused = true; socket.destroy();
    });
    assert.equal(refused, true);
    assert.equal(denied.destroyed, true);
    const headers = await f.helpers.getAuthHeaders({ userId: f.user.id });
    const socket = new Socket();
    let admitted = false;
    await f.human.protect(request(headers), socket, () => { admitted = true; }, () => assert.fail('valid upgrade refused'));
    assert.equal(admitted, true);
    await f.human.auth.api.signOut({ headers });
    assert.equal(socket.destroyed, true);
    await new Promise(resolve => setImmediate(resolve));
  } finally { f.close(); }
});

test('notification grouping uses non-credential session IDs and live adapter authority', async () => {
  const f = await fixture();
  try {
    const headers = await f.helpers.getAuthHeaders({ userId: f.user.id });
    const session = await f.human.resolve(request(headers));
    const group = `human:${session.session.id}`;
    assert.equal(await f.human.authorizeUiSession(group), true);
    for (const forged of [session.session.token, 'legacy', 'human:', 'human:../id', 'human:missing']) {
      assert.equal(await f.human.authorizeUiSession(forged), false);
    }
    f.database.prepare('UPDATE user SET emailVerified = 0 WHERE id = ?').run(f.user.id);
    assert.equal(await f.human.authorizeUiSession(group), false);
    f.database.prepare('UPDATE user SET emailVerified = 1 WHERE id = ?').run(f.user.id);
    await f.human.auth.api.signOut({ headers });
    assert.equal(await f.human.authorizeUiSession(group), false);
    const other = await f.helpers.getAuthHeaders({ userId: f.user.id });
    const next = await f.human.resolve(request(other));
    f.database.prepare('UPDATE session SET expiresAt = 0 WHERE id = ?').run(next.session.id);
    assert.equal(await f.human.authorizeUiSession(`human:${next.session.id}`), false);
  } finally { f.close(); }
});

test('real HTTP auth handler rejects cross-origin account mutations and expired sessions', async () => {
  const f = await fixture();
  try {
    const headers = await f.helpers.getAuthHeaders({ userId: f.user.id });
    headers.set('origin', 'https://attacker.test');
    headers.set('content-type', 'application/json');
    const denied = await f.human.auth.handler(new Request(`${config.baseURL}/api/auth/update-user`, {
      method: 'POST', headers, body: JSON.stringify({ name: 'Forged' }),
    }));
    assert.equal(denied.status, 403);
    assert.equal((await f.human.resolve(request(headers))).user.name, 'Person');
    headers.set('origin', config.baseURL);
    const accepted = await f.human.auth.handler(new Request(`${config.baseURL}/api/auth/update-user`, {
      method: 'POST', headers, body: JSON.stringify({ name: 'Changed' }),
    }));
    assert.equal(accepted.status, 200);
    assert.equal((await f.human.resolve(request(headers))).user.name, 'Changed');
    f.database.prepare('UPDATE session SET expiresAt = 0 WHERE userId = ?').run(f.user.id);
    assert.equal(await f.human.resolve(request(headers)), null);
  } finally { f.close(); }
});

test('official user creation hooks deny unverified and outsider Google claims', async () => {
  const f = await fixture();
  try {
    for (const claims of [{ email: 'outsider@elsewhere.test', emailVerified: true },
      { email: 'unverified@example.test', emailVerified: false },
      { email: 'lookalike@example.test.attacker.test', emailVerified: true }]) {
      await assert.rejects(f.helpers.saveUser(f.helpers.createUser(claims)));
    }
    const result = await f.human.auth.api.signInSocial({ body: { provider: 'google', callbackURL: config.baseURL } });
    const url = new URL(result.url);
    assert.equal(url.hostname, 'accounts.google.com');
    assert.equal(url.searchParams.get('client_id'), config.googleClientId);
    assert.equal(url.searchParams.get('redirect_uri'), `${config.baseURL}/api/auth/callback/google`);
    assert.equal(f.database.prepare('SELECT count(*) AS total FROM user').get().total, 1);
  } finally { f.close(); }
});

test('audience is checked again on requests, and profile mutations cannot change identity', async () => {
  const f = await fixture();
  try {
    const headers = await f.helpers.getAuthHeaders({ userId: f.user.id });
    for (const name of ['bad\nname', '\u202eadmin', '']) {
      await assert.rejects(f.human.auth.api.updateUser({ headers, body: { name } }));
    }
    await assert.rejects(f.human.auth.api.updateUser({ headers, body: { image: 'javascript:alert(1)' } }));
    // Change only the disposable database to model withdrawal of verified audience membership.
    f.database.prepare('UPDATE user SET emailVerified = 0 WHERE id = ?').run(f.user.id);
    assert.equal(await f.human.resolve(request(headers)), null);
    await assert.rejects(f.helpers.getAuthHeaders({ userId: f.user.id }));
    assert.equal(f.human.auth.options.account.accountLinking.enabled, false);
    assert.deepEqual(Object.keys(f.human.auth.options.socialProviders), ['google']);
    assert.equal(f.human.auth.options.session.cookieCache.enabled, false);
  } finally { f.close(); }
});

// smarty-code#2290: the home-screen app opened with an expired sign-in. The guard is mounted at /api (req.url relative,
// req.originalUrl whole), as the web server mounts it.
const recorder = () => Object.assign(new EventEmitter(), { statusCode: 200, headers: {}, body: undefined, ended: false,
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; this.ended = true; return this; },
  end() { this.ended = true; },
  destroy() { this.destroyed = true; this.emit('close'); } }); // An admitted response is a live connection (dispose closes it).
// dest null: no Sec-Fetch-Dest header at all.
const visit = (path, { method = 'GET', dest = 'document', headers = [] } = {}) => ({ method, originalUrl: path, url: path.replace(/^\/api/, ''),
  headers: { ...(dest === null ? {} : { 'sec-fetch-dest': dest }), ...Object.fromEntries(headers) } });
const guard = async (f, req, reject) => {
  const res = recorder(); let admitted = false;
  await f.human.protect(req, res, () => { admitted = true; }, ...(reject ? [reject] : []));
  return { res, admitted };
};
const JSON_401 = { authenticated: false, locked: true, humanAuthRequired: true };

test('#2290: a signed-out document visit of /api/app/ goes to the sign-in with a safe return; the session still admits', async () => {
  const f = await fixture();
  try {
    for (const [path, location] of [['/api/app/', '/?return=%2Fapi%2Fapp%2F'], ['/api/app/sessions/abc?x=1#y', '/?return=%2Fapi%2Fapp%2Fsessions%2Fabc']]) {
      const { res, admitted } = await guard(f, visit(path));
      assert.deepEqual([path, res.statusCode, res.headers.location, res.headers['cache-control'], res.ended, admitted],
        [path, 302, location, 'no-store', true, false]);
    }
    const headers = await f.helpers.getAuthHeaders({ userId: f.user.id });
    const signedIn = await guard(f, visit('/api/app/', { headers }));
    assert.equal(signedIn.admitted, true); // Signed in: the app, as before.
  } finally { f.close(); }
});

test('#2290: an API call, a non-GET, another path or no Sec-Fetch-Dest keeps the JSON 401; an upgrade keeps its own refusal', async () => {
  const f = await fixture();
  try {
    for (const req of [visit('/api/app/', { dest: 'empty' }), visit('/api/app/', { method: 'POST' }), visit('/api/app/', { dest: null }),
      visit('/api/sessions'), visit('/api/application'), visit('/api/app', {})]) {
      const { res, admitted } = await guard(f, req);
      assert.deepEqual([req.originalUrl, req.method, res.statusCode, res.body, res.headers.location, admitted],
        [req.originalUrl, req.method, 401, JSON_401, undefined, false]);
    }
    let refused = false;
    const { res } = await guard(f, visit('/api/app/'), () => { refused = true; });
    assert.deepEqual([refused, res.statusCode, res.headers.location], [true, 200, undefined]); // A custom refusal (upgrade): its own.
  } finally { f.close(); }
});

test('#2290: a return that is not a plain same-origin /api/app/ path is refused: the sign-in, with no return', async () => {
  const f = await fixture();
  try {
    for (const path of ['/api/app//evil.example/x', '/api/app/../admin', '/api/app/./x', '/api/app/%2e%2e/x', '/api/app/%2F%2Fevil', '/api/app/\\evil',
      '/api/app/a\u0007b', `/api/app/${'a'.repeat(1100)}`]) {
      const { res } = await guard(f, visit(path));
      assert.deepEqual([path.slice(0, 40), res.statusCode, res.headers.location], [path.slice(0, 40), 302, '/']);
    }
  } finally { f.close(); }
  for (const value of ['//evil.example/api/app/', 'https://evil.example/api/app/', '/api/app/../x', '/api/app/a?b', '/api/app/a#b',
    '/api/apps/x', '/api/app', '/API/APP/', 'javascript:/api/app/', '/api/app/\u2028', null, 42])
    assert.equal(safeAppReturn(value), null, String(value));
  for (const value of ['/api/app/', '/api/app/sessions/abc-1_2.3'])
    assert.equal(safeAppReturn(value), value);
});
