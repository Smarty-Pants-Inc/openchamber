import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, sign } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { testUtils } from 'better-auth/plugins';
import { createHumanAuth } from './human-auth.js';
import { createConfiguredHumanAuth } from './human-auth-config.js';

// smarty-code#1391: SMARTY_HUMAN_AUTH_ALLOWED_EMAILS_FILE admits only listed people, at sign-in and on every request.
afterEach(() => vi.restoreAllMocks());
const origin = 'http://localhost:43210';

async function fixture(emails) {
  const root = mkdtempSync(join(tmpdir(), 'human-members-'));
  const file = join(root, 'members.json');
  const write = list => { writeFileSync(file, JSON.stringify({ emails: list }), { mode: 0o600 }); chmodSync(file, 0o600); };
  if (emails) write(emails);
  const database = new DatabaseSync(':memory:');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const human = await createHumanAuth({ database, baseURL: origin, secret: 'fixture-only-secret-thirty-two-characters',
    googleClientId: 'fixture-client', googleClientSecret: 'fixture-secret', allowedDomains: ['example.test'],
    env: { SMARTY_HUMAN_AUTH_ALLOWED_EMAILS_FILE: file } });
  return { root, file, write, database, human,
    close: () => { human.dispose(); database.close(); rmSync(root, { recursive: true, force: true }); } };
}

function googleFixture(human) {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
  const state = { claims: null };
  const enc = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.href === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [jwk] });
    assert.equal(url.href, 'https://oauth2.googleapis.com/token', 'unexpected outbound fixture request');
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${enc({ alg: 'RS256', kid: 'fixture-key' })}.${enc({
      iss: 'https://accounts.google.com', aud: 'fixture-client', name: 'Person', iat: now, exp: now + 300,
      email_verified: true, hd: 'example.test', ...state.claims,
    })}`;
    const idToken = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), keys.privateKey).toString('base64url')}`;
    return Response.json({ access_token: 'fixture-access', token_type: 'Bearer', expires_in: 300, id_token: idToken });
  });
  const jar = new Map();
  const request = async (path, body) => {
    const headers = { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), origin };
    const options = { headers };
    if (body) {
      headers['content-type'] = 'application/json';
      Object.assign(options, { method: 'POST', body: JSON.stringify(body) });
    }
    const response = await human.auth.handler(new Request(origin + path, options));
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';'), index = pair.indexOf('=');
      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return response;
  };
  const login = async claims => {
    state.claims = claims;
    jar.clear();
    const start = await request('/api/auth/sign-in/social', { provider: 'google', callbackURL: origin });
    const url = new URL((await start.json()).url);
    const response = await request(`/api/auth/callback/google?code=fixture-code&state=${encodeURIComponent(url.searchParams.get('state'))}`);
    return { response, session: await (await request('/api/auth/get-session')).json() };
  };
  return { login };
}

test('Google sign-in admits a listed member and refuses an unlisted same-domain account', async () => {
  const f = await fixture(['paul@example.test']);
  try {
    const google = googleFixture(f.human);
    const member = await google.login({ sub: 'google-paul', email: 'Paul@example.test' });
    assert.equal(member.response.status, 302);
    assert.equal(member.session.user.email.toLowerCase(), 'paul@example.test');
    const outsider = await google.login({ sub: 'google-marisela', email: 'marisela@example.test' });
    assert.equal(outsider.session, null);
    assert.match(outsider.response.headers.get('location'), /account_not_allowed/);
    assert.equal(f.database.prepare("SELECT count(*) AS n FROM user WHERE email = 'marisela@example.test'").get().n, 0);
  } finally { f.close(); }
});

test('an invalid members list denies every sign-in', async () => {
  const f = await fixture(null);
  try {
    writeFileSync(f.file, '{"emails":', { mode: 0o600 });
    const google = googleFixture(f.human);
    const denied = await google.login({ sub: 'google-paul', email: 'paul@example.test' });
    assert.equal(denied.session, null);
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM session').get().n, 0);
  } finally { f.close(); }
});

test('removing a person from the list refuses their existing session and closes open streams, without restart', async () => {
  const f = await fixture(['paul@example.test', 'marisela@example.test']);
  try {
    const testAuth = betterAuth({ ...f.human.auth.options,
      user: { ...f.human.auth.options.user, validateUserInfo: undefined }, plugins: [testUtils()] });
    const helpers = (await testAuth.$context).test;
    const marisela = await helpers.saveUser(helpers.createUser({ name: 'M', email: 'marisela@example.test', emailVerified: true }));
    const paul = await helpers.saveUser(helpers.createUser({ name: 'P', email: 'paul@example.test', emailVerified: true }));
    const req = async user => ({ headers: Object.fromEntries(await helpers.getAuthHeaders({ userId: user.id })) });
    const removed = await req(marisela), kept = await req(paul);
    const current = await f.human.resolve(removed);
    assert.ok(current);
    const stream = new EventEmitter();
    let destroyed = false, admitted = false;
    stream.destroy = () => { destroyed = true; stream.emit('close'); };
    await f.human.protect(removed, stream, () => { admitted = true; });
    assert.equal(admitted, true);

    f.write(['paul@example.test']);
    assert.equal(await f.human.resolve(removed), null);
    assert.equal(await f.human.authorizeUiSession(`human:${current.session.id}`), false);
    let status;
    await f.human.protect(removed, { status: code => { status = code; return { json: () => {} }; } }, () => assert.fail('admitted'));
    assert.equal(status, 401);
    assert.equal(await f.human.resolve(removed).then(Boolean), false);
    assert.ok(await f.human.resolve(kept), 'a listed person keeps working');
    await vi.waitFor(() => assert.equal(destroyed, true), { timeout: 3000 });
  } finally { f.close(); }
});

test('a members list path must be absolute when set', async () => {
  const root = mkdtempSync(join(tmpdir(), 'human-config-'));
  try {
    const env = { OPENCHAMBER_HUMAN_AUTH: 'google', OPENCHAMBER_HUMAN_AUTH_DB: join(root, 'human.sqlite'),
      BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: 'fixture-only-secret-at-least-thirty-two-characters',
      GOOGLE_CLIENT_ID: 'fixture-client', GOOGLE_CLIENT_SECRET: 'fixture-secret', SMARTY_HUMAN_AUTH_ALLOWED_DOMAINS: 'example.test' };
    for (const value of ['', 'members.json']) {
      await assert.rejects(createConfiguredHumanAuth({ ...env, SMARTY_HUMAN_AUTH_ALLOWED_EMAILS_FILE: value }), /ALLOWED_EMAILS_FILE/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
