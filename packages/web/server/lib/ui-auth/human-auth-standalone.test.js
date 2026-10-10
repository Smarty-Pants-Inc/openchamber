import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createHumanAuth } from './human-auth.js';

afterEach(() => vi.restoreAllMocks());

// smarty-code#1489: an iOS home-screen app has its own cookie jar. Google sign-in must therefore be a same-window
// round trip that lands back on an in-scope URL, and leave a session cookie the app keeps after it is killed:
// HttpOnly, Secure, SameSite=Lax, with a persistent Max-Age (not a session-only cookie). Real Better Auth routes;
// synthetic Google token/JWKS endpoints only.
test('Google sign-in over HTTPS returns in scope with a persistent Lax Secure session cookie', async () => {
  const database = new DatabaseSync(':memory:');
  const origin = 'https://code.example.test';
  const human = await createHumanAuth({ database, baseURL: origin, secret: 'fixture-only-secret-thirty-two-characters',
    googleClientId: 'fixture-client', googleClientSecret: 'fixture-secret', allowedDomains: ['example.test'] });
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
  const enc = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.href === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [jwk] });
    assert.equal(url.href, 'https://oauth2.googleapis.com/token', 'unexpected outbound fixture request');
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${enc({ alg: 'RS256', kid: 'fixture-key' })}.${enc({ iss: 'https://accounts.google.com',
      aud: 'fixture-client', sub: 'fixture-person', name: 'Ada', iat: now, exp: now + 300,
      email: 'ada@example.test', email_verified: true, hd: 'example.test' })}`;
    const idToken = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), keys.privateKey).toString('base64url')}`;
    return Response.json({ access_token: 'fixture-access', token_type: 'Bearer', expires_in: 300, id_token: idToken });
  });
  const jar = new Map(), setCookies = [];
  async function request(path, body) {
    const headers = { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), origin };
    const options = { headers };
    if (body) Object.assign(options, { method: 'POST', body: JSON.stringify(body) }, { headers: { ...headers, 'content-type': 'application/json' } });
    const response = await human.auth.handler(new Request(origin + path, options));
    for (const cookie of response.headers.getSetCookie()) {
      setCookies.push(cookie);
      const [pair] = cookie.split(';'), index = pair.indexOf('=');
      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return response;
  }
  const attributes = cookie => Object.fromEntries(cookie.split(';').slice(1)
    .map(part => part.trim().split('=')).map(([k, v = true]) => [k.toLowerCase(), v]));
  try {
    const inScope = `${origin}/?session=abc`;
    const start = await request('/api/auth/sign-in/social', { provider: 'google', callbackURL: inScope, disableRedirect: true });
    assert.equal(start.status, 200);
    const google = new URL((await start.json()).url);
    assert.equal(google.origin, 'https://accounts.google.com');
    assert.equal(google.searchParams.get('redirect_uri'), `${origin}/api/auth/callback/google`);
    // The OAuth state cookie must come back on Google's top-level GET redirect: Lax, not Strict.
    const state = setCookies.find(cookie => /state/i.test(cookie.split('=')[0]));
    if (state) assert.equal(String(attributes(state).samesite).toLowerCase(), 'lax');

    const callback = await request(`/api/auth/callback/google?code=fixture-code&state=${encodeURIComponent(google.searchParams.get('state'))}`);
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), inScope, 'Google returns to the in-scope page, not elsewhere');

    const session = setCookies.find(cookie => cookie.startsWith('__Secure-better-auth.session_token='));
    assert.ok(session, `session cookie set: ${setCookies.map(cookie => cookie.split('=')[0]).join(', ')}`);
    const attrs = attributes(session);
    assert.equal(attrs.httponly, true);
    assert.equal(attrs.secure, true);
    assert.equal(String(attrs.samesite).toLowerCase(), 'lax');
    assert.equal(attrs.path, '/');
    assert.ok(Number(attrs['max-age']) >= 7 * 24 * 3600, `persistent Max-Age, got ${attrs['max-age']}`);
    assert.equal((await (await request('/api/auth/get-session')).json()).user.email, 'ada@example.test');
  } finally { human.dispose(); database.close(); }
});
