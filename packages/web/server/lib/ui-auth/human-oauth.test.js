import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createHumanAuth } from './human-auth.js';

// Real library callback/state/account/session paths; synthetic Google token/JWKS endpoints only.
// This proves neither actual Google enrollment nor an owner browser sign-in.
test('returning Google callback preserves subject/profile but checks fresh verified audience', async (t) => {
  const database = new DatabaseSync(':memory:');
  const origin = 'http://localhost:43210';
  const human = await createHumanAuth({ database, baseURL: origin,
    secret: 'fixture-only-secret-thirty-two-characters', googleClientId: 'fixture-client',
    googleClientSecret: 'fixture-secret', allowedDomains: ['example.test'] });
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
  let claims = { email: 'person@example.test', email_verified: true };
  const enc = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.href === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [jwk] });
    assert.equal(url.href, 'https://oauth2.googleapis.com/token', 'unexpected outbound fixture request');
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${enc({ alg: 'RS256', kid: 'fixture-key' })}.${enc({
      iss: 'https://accounts.google.com', aud: 'fixture-client', sub: 'fixture-google-person',
      name: 'Provider Name', iat: now, exp: now + 300, ...claims,
    })}`;
    const idToken = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), keys.privateKey).toString('base64url')}`;
    return Response.json({ access_token: 'fixture-access', token_type: 'Bearer', expires_in: 300, id_token: idToken });
  });
  const jar = new Map();
  async function request(path, body) {
    const headers = { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), origin,
      ...(body ? { 'content-type': 'application/json' } : {}) };
    const response = await human.auth.handler(new Request(origin + path, {
      headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    }));
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';'), index = pair.indexOf('=');
      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return response;
  }
  async function login() {
    const start = await request('/api/auth/sign-in/social', { provider: 'google', callbackURL: origin });
    assert.equal(start.status, 200);
    const url = new URL((await start.json()).url);
    assert.equal(url.origin, 'https://accounts.google.com');
    const response = await request(`/api/auth/callback/google?code=fixture-code&state=${encodeURIComponent(url.searchParams.get('state'))}`);
    const session = await (await request('/api/auth/get-session')).json();
    return { response, session };
  }
  try {
    const first = await login();
    assert.equal(first.response.status, 302);
    assert.ok(first.session.user.id);
    assert.equal((await request('/api/auth/update-user', { name: 'Chosen Name' })).status, 200);
    await request('/api/auth/sign-out', {});
    const returning = await login();
    assert.equal(returning.session.user.id, first.session.user.id);
    assert.equal(returning.session.user.name, 'Chosen Name');
    await request('/api/auth/sign-out', {});
    for (const fresh of [
      { email: 'outsider@elsewhere.test', email_verified: true },
      { email: 'suffix@example.test.attacker.test', email_verified: true },
      { email: 'person@example.test', email_verified: false },
      { sub: 'new-outsider', email: 'new@elsewhere.test', email_verified: true },
    ]) {
      claims = fresh;
      const denied = await login();
      assert.equal(denied.session, null);
      assert.match(denied.response.headers.get('location'), /account_not_allowed/);
      assert.equal(database.prepare('SELECT count(*) AS n FROM session').get().n, 0);
    }
    assert.equal(database.prepare('SELECT count(*) AS n FROM user').get().n, 1);
    const forged = await request('/api/auth/callback/google?code=fixture-code&state=forged');
    assert.notEqual(forged.headers.get('location'), origin);
    assert.equal(await (await request('/api/auth/get-session')).json(), null);
  } finally { human.dispose(); database.close(); }
});
