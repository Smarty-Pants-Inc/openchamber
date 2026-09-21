import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { betterAuth } from 'better-auth';
import { testUtils } from 'better-auth/plugins';
import { createHumanAuth } from './human-auth.js';

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
