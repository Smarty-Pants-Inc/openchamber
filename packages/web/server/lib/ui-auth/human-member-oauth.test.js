import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { fixture, record, config, googleIssuer, googleSubject, member } from './human-member-fixture.js';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'member-fixture-key', alg: 'RS256', use: 'sig' };
const enc = value => Buffer.from(JSON.stringify(value)).toString('base64url');

// The production code-exchange callback relies on Google's token endpoint, decodes its ID token,
// and creates the adapter account row; this is not a token-signature verification/rejection test.
// Google's token/JWKS endpoints are synthetic. No session-seeding plugin is used here.
for (const state of ['unknown', 'ambiguous', 'removed', 'active']) test(`verified Google callback binds ${state} Record B login`, async () => {
  const f = await fixture({ seed: false });
  const jar = new Map(); let outbound = 0;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = new URL(input instanceof Request ? input.url : input);
    outbound++;
    if (url.href === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [jwk] });
    assert.equal(url.href, 'https://oauth2.googleapis.com/token', 'unexpected outbound request');
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${enc({ alg: 'RS256', kid: jwk.kid })}.${enc({ iss: googleIssuer,
      aud: config.googleClientId, sub: googleSubject, iat: now, exp: now + 300,
      name: 'Google Person', email: 'person@example.test', email_verified: true, hd: 'example.test' })}`;
    const idToken = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), keys.privateKey).toString('base64url')}`;
    return Response.json({ access_token: 'fixture-access', token_type: 'Bearer', expires_in: 300, id_token: idToken });
  });
  const headers = () => ({ cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '), origin: config.baseURL });
  const request = async (path, body) => {
    const options = { headers: headers() };
    if (body) {
      options.method = 'POST'; options.headers['content-type'] = 'application/json'; options.body = JSON.stringify(body);
    }
    const res = await f.human.auth.handler(new Request(config.baseURL + path, options));
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split('; '), index = pair.indexOf('=');
      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return res;
  };
  try {
    const data = record();
    if (state === 'unknown') data.logins = [];
    if (state === 'ambiguous') data.logins.push({ ...data.logins[0] });
    if (state === 'removed') data.orgs[0].members[0].status = 'removed';
    await f.publish(data);
    const start = await request('/api/auth/sign-in/social', { provider: 'google', callbackURL: config.baseURL });
    assert.equal(start.status, 200);
    const stateToken = new URL((await start.json()).url).searchParams.get('state');
    const callback = await request(`/api/auth/callback/google?code=fixture-code&state=${encodeURIComponent(stateToken)}`);
    assert.equal(callback.status, 302);
    const raw = await f.human.auth.api.getSession({ headers: new Headers(headers()) });
    assert.ok(raw, 'the actual provider seam issued a real Better Auth session');
    const accounts = await f.adapter.findMany({ model: 'account', where: [{ field: 'userId', value: raw.user.id }] });
    assert.equal(accounts.length, 1); assert.equal(accounts[0].providerId, 'google');
    assert.equal(accounts[0].accountId, googleSubject);
    assert.notEqual(raw.user.id, googleSubject);
    const resolved = await f.human.resolve({ headers: headers() });
    if (state === 'active') {
      assert.ok(resolved);
      assert.deepEqual(f.human.actor(resolved, { forwarded: true }).member, member);
      assert.equal(f.human.actor(resolved).subject, raw.user.id);
      assert.equal(Object.hasOwn(f.human.actor(resolved), 'member'), false);
    } else assert.equal(resolved, null, `${state} login cannot cross human admission`);
    assert.ok(outbound >= 1, 'the production token exchange ran');
  } finally { fetch.mockRestore(); await f.close(); }
});
