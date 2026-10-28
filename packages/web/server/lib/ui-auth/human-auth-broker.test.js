import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createServer } from 'node:http';
import { generateKeyPairSync, createHash, sign, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, writeFile, rename, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { betterAuth } from 'better-auth';
import { testUtils } from 'better-auth/plugins';
import { APIError } from 'better-auth/api';
import { createHumanAuth } from './human-auth.js';
import { createConfiguredHumanAuth } from './human-auth-config.js';

// Authentication trust boundary: real HTTP discovery/JWKS/code exchange and real BA callbacks/SQLite.
// No Google, Dex service, browser enrollment or live deployment is claimed by this loopback issuer.
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'broker-fixture', alg: 'RS256', use: 'sig' };
const secret = 'fixture-only-secret-at-least-thirty-two-characters';
const googleSub = '108765432109876543210';
const publicBase = 'http://localhost:43210/code';
const policy = { principals: [{ name: 'Ada', calendar: 'ada@smartypants.ai' }], services: { smartyCode: { members: [] } } };
const enc = value => Buffer.from(JSON.stringify(value)).toString('base64url');

async function fixture({ claims = {}, discovery = {}, discoveryStatus = 200, omitToken = false, wrongSignature = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'human-broker-'));
  const orgPath = join(root, 'org.json');
  const secretPath = join(root, 'client-secret');
  const codes = new Map(), calls = [];
  let issuer, human;
  const app = createServer((req, res) => human.handler(req, res));
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const appURL = `http://127.0.0.1:${app.address().port}`;
  const database = new DatabaseSync(':memory:');
  await writeFile(orgPath, JSON.stringify(policy));
  await writeFile(secretPath, 'fixture-client-secret\n', { mode: 0o600 });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, issuer);
    calls.push(url.pathname);
    const json = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
      if (url.pathname === '/.well-known/openid-configuration') return json({ issuer,
        authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', jwks_uri: issuer + '/keys',
        userinfo_endpoint: issuer + '/userinfo', id_token_signing_alg_values_supported: ['RS256'],
        response_types_supported: ['code'], subject_types_supported: ['public'], ...discovery }, discoveryStatus);
      if (url.pathname === '/keys') return json({ keys: [jwk] });
      if (url.pathname === '/authorize') {
        assert.equal(url.searchParams.get('client_id'), 'code-example');
        assert.equal(url.searchParams.get('redirect_uri'), publicBase + '/api/auth/callback/google');
        assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
        assert.ok(url.searchParams.get('code_challenge'));
        assert.ok(url.searchParams.get('nonce'));
        assert.deepEqual(new Set(url.searchParams.get('scope').split(' ')), new Set(['openid', 'email', 'profile', 'groups', 'federated:id']));
        const code = randomUUID();
        codes.set(code, { params: url.searchParams, claims: structuredClone(claims) });
        const callback = new URL(url.searchParams.get('redirect_uri'));
        callback.searchParams.set('code', code);
        callback.searchParams.set('state', url.searchParams.get('state'));
        res.writeHead(302, { location: callback.href }); return res.end();
      }
      if (url.pathname === '/token') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const params = new URLSearchParams(body);
        const basic = req.headers.authorization?.startsWith('Basic ')
          ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString().split(':') : null;
        assert.equal(basic?.[0] ?? params.get('client_id'), 'code-example');
        assert.equal(basic?.[1] ?? params.get('client_secret'), 'fixture-client-secret');
        assert.equal(params.get('grant_type'), 'authorization_code');
        const exchange = codes.get(params.get('code'));
        if (!exchange) return json({ error: 'invalid_grant' }, 400);
        const transaction = exchange.params;
        codes.delete(params.get('code')); // One-use, client/redirect/verifier-bound code, not a reusable token mock.
        assert.equal(params.get('redirect_uri'), transaction.get('redirect_uri'));
        assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'), transaction.get('code_challenge'));
        const now = Math.floor(Date.now() / 1000);
        const unsigned = `${enc({ alg: 'RS256', kid: jwk.kid })}.${enc({ iss: issuer, aud: 'code-example', sub: 'dex-opaque-sub',
          iat: now, exp: now + 300, nonce: transaction.get('nonce'), name: 'Ada', email: 'ada@smartypants.ai',
          email_verified: true, groups: ['hd:smartypants.ai'], federated_claims: { connector_id: 'google', user_id: googleSub }, ...exchange.claims })}`;
        const signingKey = wrongSignature ? generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey : keys.privateKey;
        const token = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), signingKey).toString('base64url')}`;
        const result = { access_token: 'fixture-access', token_type: 'Bearer', expires_in: 300 };
        if (!omitToken) result.id_token = token;
        return json(result);
      }
      return json({ error: 'unexpected endpoint' }, 404);
    } catch { return json({ error: 'fixture contract failed' }, 500); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${server.address().port}`;
  const env = { SMARTY_CODE_ORG_CONFIG: orgPath };
  const broker = { issuer, clientId: 'code-example', clientSecret: 'fixture-client-secret', connector: 'google' };
  const options = { database, baseURL: publicBase, secret, allowedDomains: ['smartypants.ai'], env, broker };
  const jar = new Map();
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const request = async (path, body, retainedCookie = cookie()) => {
    const headers = { cookie: retainedCookie, origin: new URL(publicBase).origin };
    const init = { headers, redirect: 'manual' };
    if (body !== undefined) { headers['content-type'] = 'application/json'; init.method = 'POST'; init.body = JSON.stringify(body); }
    // This is the Node handler the server mounts, not just auth.handler or auth.api.
    const response = await fetch(appURL + '/code' + path, init);
    for (const setCookie of response.headers.getSetCookie()) {
      const pair = setCookie.split(';')[0], index = pair.indexOf('=');
      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return response;
  };
  return { database, calls, env, broker, root, secretPath, orgPath, options, cookie, request,
    get human() { return human; },
    async start(overrides = {}) { human = await createHumanAuth({ ...options, ...overrides }); return human; },
    async beginLogin() {
      const start = await request('/api/auth/sign-in/social', { provider: 'google', callbackURL: publicBase + '/' });
      assert.equal(start.status, 200);
      const authorization = await fetch((await start.json()).url, { redirect: 'manual' });
      assert.equal(authorization.status, 302, 'issuer accepts the actual PKCE/nonce/redirect contract');
      return new URL(authorization.headers.get('location'));
    },
    async login() {
      const callback = await this.beginLogin();
      const response = await request('/api/auth/callback/google' + callback.search);
      return { response, callback };
    },
    async outage() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
    async publish(value) { await writeFile(orgPath + '.next', JSON.stringify(value)); await rename(orgPath + '.next', orgPath); },
    async close() { human?.dispose(); app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); database.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); },
  };
}
const count = (f, table) => f.database.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
function noSessionCookie(response) {
  assert.equal(response.headers.getSetCookie().some(cookie => /(?:^|-)better-auth\.session_token=/.test(cookie) && !cookie.includes('Max-Age=0')), false);
}

test('broker member completes /code code flow with S256, nonce, pinned provider and Google account ID', async () => {
  const f = await fixture();
  try {
    await f.start();
    const provider = (await f.human.auth.$context).socialProviders.find(p => p.id === 'google');
    assert.equal(provider.issuer, f.broker.issuer);
    assert.equal(provider.requiresIdTokenNonce, true);
    assert.deepEqual(provider.idToken.algorithms, ['RS256']);
    assert.deepEqual(f.human.auth.options.plugins.map(p => p.id), ['smarty-human-auth-public-path-redirects', 'smarty-human-auth-no-client-id-token', 'generic-oauth']);
    const { response } = await f.login();
    assert.equal(response.headers.get('location'), publicBase + '/');
    assert.ok(response.headers.getSetCookie().some(c => c.includes('session_token=') && c.includes('Path=/code') && !c.includes('Domain=')));
    const session = await f.human.resolve({ headers: { cookie: f.cookie() } });
    assert.equal(session.user.email, 'ada@smartypants.ai');
    assert.equal(await f.human.authorizeUiSession(`human:${session.session.id}`), true);
    assert.deepEqual({ ...f.database.prepare('SELECT providerId, accountId FROM account').get() }, { providerId: 'google', accountId: googleSub });
    assert.equal(f.database.prepare('SELECT workspacePolicy FROM session').get().workspacePolicy, 'google-hd:smartypants.ai');
    assert.equal(f.calls.includes('/userinfo'), false);
  } finally { await f.close(); }
});

const refusals = [
  ['wrong issuer', { iss: 'https://foreign.example' }],
  ['foreign org audience', { aud: 'code-foreign' }],
  ['multiple audiences', { aud: ['code-example', 'code-foreign'] }],
  ['array audience even when single', { aud: ['code-example'] }],
  ['wrong azp', { azp: 'code-foreign' }],
  ['null azp', { azp: null }],
  ['wrong connector', { federated_claims: { connector_id: 'foreign', user_id: googleSub } }],
  ['missing upstream subject', { federated_claims: { connector_id: 'google' } }],
  ['invalid upstream subject', { federated_claims: { connector_id: 'google', user_id: '<forged>' } }],
  ['missing hd group', { groups: [] }],
  ['wrong hd group', { groups: ['hd:smartypants.ai.attacker.test'] }],
  ['non-array groups', { groups: 'hd:smartypants.ai' }],
  ['unverified email', { email_verified: false }],
  ['truthy email verification', { email_verified: 'true' }],
  ['same-domain non-member', { email: 'outsider@smartypants.ai' }],
  ['foreign email domain', { email: 'ada@foreign.example' }],
  ['wrong nonce', { nonce: 'foreign-transaction' }],
  ['missing nonce', { nonce: undefined }],
  ['expired token', { exp: 1 }],
];
test.each(refusals)('broker refuses %s before user/account/session rows or cookie', async (_name, claims) => {
  const f = await fixture({ claims });
  try {
    await f.start();
    const { response } = await f.login();
    assert.notEqual(response.headers.get('location'), publicBase + '/');
    noSessionCookie(response);
    for (const table of ['user', 'account', 'session']) assert.equal(count(f, table), 0, `${table} remains empty`);
    assert.equal(await f.human.resolve({ headers: { cookie: f.cookie() } }), null);
  } finally { await f.close(); }
});

test.each([{ omitToken: true }, { wrongSignature: true }])('broker requires a signed ID token, never userinfo: %j', async config => {
  const f = await fixture(config);
  try {
    await f.start();
    const { response } = await f.login(); noSessionCookie(response);
    for (const table of ['user', 'account', 'session']) assert.equal(count(f, table), 0);
    assert.equal(f.calls.includes('/userinfo'), false);
  } finally { await f.close(); }
});

test.each([
  ['service member', { principals: [], services: { smartyCode: { members: [{ name: 'Ada', email: 'ADA@SMARTYPANTS.AI' }] } } }],
  ['explicit azp', policy, { azp: 'code-example' }],
])('broker accepts %s', async (_name, org, claims) => {
  const f = await fixture({ claims });
  try { await f.publish(org); await f.start(); const { response } = await f.login(); assert.equal(response.headers.get('location'), publicBase + '/'); assert.equal(count(f, 'session'), 1); }
  finally { await f.close(); }
});

test.each([
  ['duplicate principal email', { principals: [policy.principals[0], policy.principals[0]] }],
  ['duplicate across member lists', { ...policy, services: { smartyCode: { members: [policy.principals[0]] } } }],
  ['non-object policy', null],
  ['malformed services', { ...policy, services: [] }],
  ['malformed service config', { ...policy, services: { smartyCode: 'invalid' } }],
  ['null service members', { ...policy, services: { smartyCode: { members: null } } }],
  ['malformed principal', { principals: [{ name: 'Ada', email: 1 }] }],
  ['malformed service members', { ...policy, services: { smartyCode: { members: {} } } }],
  ['empty membership', { principals: [] }],
])('broker fails closed for %s', async (_name, org) => {
  const f = await fixture();
  try { await f.publish(org); await f.start(); const { response } = await f.login(); noSessionCookie(response); for (const table of ['user', 'account', 'session']) assert.equal(count(f, table), 0); }
  finally { await f.close(); }
});

test('member removal refuses returning callback, session creation, resolution and UI authorization', async () => {
  const f = await fixture();
  try {
    await f.start(); await f.login();
    const admitted = await f.human.resolve({ headers: { cookie: f.cookie() } });
    const seeder = betterAuth({ ...f.human.auth.options, plugins: [testUtils()] });
    const helper = (await seeder.$context).test;
    await f.publish({ principals: [] });
    assert.equal(await f.human.resolve({ headers: { cookie: f.cookie() } }), null);
    assert.equal(await f.human.authorizeUiSession(`human:${admitted.session.id}`), false);
    await assert.rejects(helper.getAuthHeaders({ userId: admitted.user.id }), error => error.status === 'FORBIDDEN');
    const { response } = await f.login(); noSessionCookie(response);
    assert.equal(count(f, 'session'), 0, 'the refused session read revokes the existing row; callback creates none');
    assert.equal(count(f, 'account'), 1); assert.equal(count(f, 'user'), 1);
    await rm(f.orgPath);
    assert.equal(await f.human.resolve({ headers: { cookie: f.cookie() } }), null);
  } finally { await f.close(); }
});

test('same Google sub reuses direct account and preserves live sessions through cutover and rollback', async () => {
  const f = await fixture();
  try {
    const directOptions = { broker: null, googleClientId: 'fixture-google-client', googleClientSecret: 'fixture-google-secret' };
    await f.start(directOptions);
    const seeder = betterAuth({ ...f.human.auth.options, user: { ...f.human.auth.options.user, validateUserInfo: undefined }, plugins: [testUtils()] });
    const ctx = await seeder.$context, helper = ctx.test;
    const user = await helper.saveUser(helper.createUser({ email: 'ada@smartypants.ai', emailVerified: true }));
    const account = await ctx.internalAdapter.createAccount({ userId: user.id, providerId: 'google', accountId: googleSub });
    const headers = Object.fromEntries(await helper.getAuthHeaders({ userId: user.id }));
    const prior = await f.human.resolve({ headers });
    f.human.dispose(); await f.start();
    assert.equal((await f.human.resolve({ headers })).session.id, prior.session.id);
    await f.login();
    const session = await f.human.resolve({ headers: { cookie: f.cookie() } });
    assert.equal(session.user.id, user.id);
    assert.equal(f.database.prepare('SELECT id FROM account').get().id, account.id);
    assert.equal(count(f, 'user'), 1); assert.equal(count(f, 'account'), 1);
    f.human.dispose(); await f.start(directOptions);
    assert.equal((await f.human.resolve({ headers })).session.id, prior.session.id);
    assert.equal((await f.human.resolve({ headers: { cookie: f.cookie() } })).user.id, user.id);
  } finally { await f.close(); }
});

test.each(['/sign-in/social', '/link-social'])('broker rejects browser-supplied idToken at %s', async path => {
  const f = await fixture();
  try { await f.start(); const response = await f.request('/api/auth' + path, { provider: 'google', idToken: { token: 'fixture-browser-token' } }); assert.equal(response.status, 404); noSessionCookie(response); assert.equal(count(f, 'session'), 0); }
  finally { await f.close(); }
});

test.each([
  ['failed discovery', { discoveryStatus: 503 }],
  ['discovery issuer mismatch', { discovery: { issuer: 'https://foreign.example' } }],
  ['no verification keys', { discovery: { jwks_uri: undefined } }],
  ['absent google provider', { discovery: { authorization_endpoint: undefined } }],
])('startup throws before returning auth for %s', async (_name, config) => {
  const f = await fixture(config);
  try { await assert.rejects(f.start(), /broker discovery/); assert.equal(f.human, undefined); assert.ok(f.calls.every(path => path === '/.well-known/openid-configuration')); }
  finally { await f.close(); }
});

// Security pass (P2): the upstream connector is pinned in code to Dex's Google connector; a configured non-Google
// connector (another IdP, a local/password connector) refuses at startup, before any discovery or row.
test.each([['ldap'], ['local'], ['github'], ['Google'], [' google'], ['']])('a non-Google broker connector %j refuses at startup', async (connector) => {
  const f = await fixture();
  try {
    await assert.rejects(f.start({ broker: { ...f.broker, connector } }), /configuration is incomplete/);
    assert.equal(f.human, undefined);
    assert.deepEqual(f.calls, []);
  } finally { await f.close(); }
});

test('running broker controller resolves existing sessions during an issuer outage', async () => {
  const f = await fixture();
  try {
    await f.start(); await f.login();
    const before = await f.human.resolve({ headers: { cookie: f.cookie() } });
    await f.outage();
    assert.equal((await f.human.resolve({ headers: { cookie: f.cookie() } })).session.id, before.session.id);
    assert.equal(await f.human.authorizeUiSession(`human:${before.session.id}`), true);
    await assert.rejects(f.start(), /broker discovery/);
  } finally { await f.close(); }
});

test('malformed and oversized policy files refuse admission before any rows', async () => {
  const f = await fixture();
  try {
    await f.start();
    for (const content of ['{', ' '.repeat(1 << 20)]) {
      await writeFile(f.orgPath, content);
      const { response } = await f.login(); noSessionCookie(response);
      for (const table of ['user', 'account', 'session']) assert.equal(count(f, table), 0);
    }
  } finally { await f.close(); }
});

test('broker requires org policy and cannot opt out with PERSON_SCOPE=0', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.start({ env: {} }), /org member list/);
    await assert.rejects(f.start({ env: { ...f.env, SMARTY_CODE_PERSON_SCOPE: '0' } }), /org member list/);
    assert.deepEqual(f.calls, []);
  } finally { await f.close(); }
});

test('configured broker reads only mounted client-secret file and rejects mixed or incomplete modes', async () => {
  const f = await fixture(); let human;
  try {
    const env = { OPENCHAMBER_HUMAN_AUTH: 'google', OPENCHAMBER_HUMAN_AUTH_DB: join(f.root, 'human.sqlite'), BETTER_AUTH_URL: publicBase,
      BETTER_AUTH_SECRET: secret, SMARTY_HUMAN_AUTH_ALLOWED_DOMAINS: 'smartypants.ai', ...f.env,
      SMARTY_HUMAN_AUTH_BROKER_ISSUER: f.broker.issuer, SMARTY_HUMAN_AUTH_BROKER_CLIENT_ID: f.broker.clientId,
      SMARTY_HUMAN_AUTH_BROKER_CONNECTOR: 'google', SMARTY_HUMAN_AUTH_BROKER_CLIENT_SECRET_FILE: f.secretPath };
    for (const field of ['SMARTY_HUMAN_AUTH_BROKER_CLIENT_ID', 'SMARTY_HUMAN_AUTH_BROKER_CONNECTOR', 'SMARTY_HUMAN_AUTH_BROKER_CLIENT_SECRET_FILE']) {
      const missing = { ...env }; delete missing[field]; await assert.rejects(createConfiguredHumanAuth(missing), new RegExp(field));
    }
    await assert.rejects(createConfiguredHumanAuth({ ...env, GOOGLE_CLIENT_ID: 'mixed' }), /not both/);
    await assert.rejects(createConfiguredHumanAuth({ ...env, SMARTY_HUMAN_AUTH_BROKER_ISSUER: '' }));
    await assert.rejects(createConfiguredHumanAuth({ ...env, SMARTY_HUMAN_AUTH_BROKER_CLIENT_SECRET_FILE: 'relative' }), /absolute/);
    await assert.rejects(createConfiguredHumanAuth({ ...env, SMARTY_HUMAN_AUTH_BROKER_CLIENT_SECRET_FILE: f.root }), /unreadable or invalid/);
    await assert.rejects(createConfiguredHumanAuth({ ...env, SMARTY_HUMAN_AUTH_BROKER_CLIENT_SECRET_FILE: join(f.root, 'absent') }), /unreadable or invalid/);
    await writeFile(f.secretPath, ' \n'); await assert.rejects(createConfiguredHumanAuth(env), /unreadable or invalid/);
    await writeFile(f.secretPath, 'fixture-client-secret\n');
    await symlink(f.secretPath, join(f.root, 'projected-secret'));
    human = await createConfiguredHumanAuth({ ...env, SMARTY_HUMAN_AUTH_BROKER_CLIENT_SECRET_FILE: join(f.root, 'projected-secret') });
    assert.equal((await human.auth.$context).socialProviders.find(p => p.id === 'google').issuer, f.broker.issuer);
    assert.equal(env.SMARTY_HUMAN_AUTH_BROKER_CLIENT_SECRET, undefined);
  } finally { human?.dispose(); await f.close(); }
});

// Data safety: exercise the exposed auth API with the actual retained browser credential.
test.each([
  ['get-session', 'removed'], ['update-user', 'removed'],
  ['get-session', 'unreadable'], ['update-user', 'unreadable'],
])('raw broker API revokes member when %s is first and policy is %s', async (first, change) => {
  const f = await fixture();
  try {
    await f.start(); await f.login();
    assert.equal((await f.request('/api/auth/update-user', { name: 'Allowed edit' })).status, 200);
    const before = f.database.prepare('SELECT * FROM user').all();
    const retained = f.cookie();
    if (change === 'removed') await f.publish({ principals: [] });
    else await rm(f.orgPath);
    const read = async () => {
      const response = await f.request('/api/auth/get-session', undefined, retained);
      assert.equal(response.status, 200);
      assert.equal(await response.json(), null);
    };
    const write = async () => {
      const response = await f.request('/api/auth/update-user', { name: 'Forbidden edit' }, retained);
      assert.ok([401, 403].includes(response.status));
      assert.deepEqual(f.database.prepare('SELECT * FROM user').all(), before);
    };
    if (first === 'get-session') { await read(); await write(); }
    else { await write(); await read(); }
    assert.equal(count(f, 'session'), 0, 'refusal revokes the retained session');
    assert.equal((await f.request('/api/auth/sign-out', {}, retained)).status, 200);
  } finally { await f.close(); }
});

test.each(['removed', 'unreadable'])('raw broker sign-out still revokes when policy is %s without a prior refusal', async change => {
  const f = await fixture();
  try {
    await f.start(); await f.login();
    if (change === 'removed') await f.publish({ principals: [] });
    else await rm(f.orgPath);
    assert.equal((await f.request('/api/auth/sign-out', {})).status, 200);
    assert.equal(count(f, 'session'), 0);
  } finally { await f.close(); }
});

test.each([
  ['/list-sessions', undefined], ['/list-accounts', undefined],
  ['/get-access-token', { providerId: 'google' }], ['/revoke-sessions', {}],
])('raw broker API also refuses removed members at %s', async (path, body) => {
  const f = await fixture();
  try {
    await f.start(); await f.login();
    const before = storedRows(f);
    await f.publish({ principals: [] });
    const response = await f.request('/api/auth' + path, body);
    assert.equal(response.status, 403);
    noSessionCookie(response);
    assert.deepEqual(f.database.prepare('SELECT * FROM user ORDER BY id').all(), before.user);
    assert.deepEqual(f.database.prepare('SELECT * FROM account ORDER BY id').all(), before.account);
    assert.equal(count(f, 'session'), 0);
  } finally { await f.close(); }
});

const storedRows = f => Object.fromEntries(['user', 'account', 'session'].map(table =>
  [table, f.database.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));

test.each([
  ['new account', 'removed'], ['new account', 'unreadable'],
  ['returning account', 'removed'], ['returning account', 'unreadable'],
])('broker rolls back %s if org policy becomes %s after profile admission', async (kind, change) => {
  const claims = {};
  const f = await fixture({ claims });
  try {
    await f.start();
    // Keep real, pre-existing rows in every case, including another person's session.
    await f.publish({ principals: [...policy.principals, { name: 'Grace', email: 'grace@smartypants.ai' }] });
    claims.email = 'grace@smartypants.ai';
    claims.federated_claims = { connector_id: 'google', user_id: 'sentinel-sub' };
    await f.login();
    delete claims.email; delete claims.federated_claims;
    if (kind === 'returning account') await f.login();
    const before = storedRows(f);
    const createSession = f.human.auth.options.databaseHooks.session.create.before;
    let reachedSession = false, insertedSession = false;
    f.human.auth.options.databaseHooks.session.create.after = async () => {
      insertedSession = true;
      assert.equal(count(f, 'session'), before.session.length + 1, 'the session insert is inside the rollback boundary too');
    };
    f.human.auth.options.databaseHooks.session.create.before = async (...args) => {
      reachedSession = true;
      const added = kind === 'new account' ? 1 : 0;
      assert.equal(count(f, 'user'), before.user.length + added);
      assert.equal(count(f, 'account'), before.account.length + added);
      return createSession(...args);
    };
    const validate = f.human.auth.options.user.validateUserInfo;
    let admissions = 0;
    f.human.auth.options.user.validateUserInfo = async (...args) => {
      const result = await validate(...args);
      if (!result?.error) {
        admissions++;
        assert.equal(count(f, 'user'), before.user.length, 'interleave before provisioning writes');
        if (change === 'removed') await f.publish({ principals: [] });
        else await rm(f.orgPath);
      }
      return result;
    };
    const { response } = await f.login();
    assert.equal(admissions, 1, 'one admission snapshot per callback');
    assert.equal(reachedSession, true, 'policy changed between admission and actual session creation');
    assert.equal(insertedSession, true, 'session admission uses the original snapshot, then the publication check refuses commit');
    noSessionCookie(response);
    assert.notEqual(response.headers.get('location'), publicBase + '/');
    assert.deepEqual(storedRows(f), before, 'zero new rows and byte-for-byte unchanged existing rows');
  } finally { await f.close(); }
});

test.each([
  ['account.before', 'throw'], ['session.before', 'throw'], ['session.after', 'throw'],
  ['user.before', 'false'], ['account.before', 'false'], ['session.before', 'false'],
])('broker rolls back all provisioning writes on a late %s denial (%s)', async (stage, refusal) => {
  const claims = { email: 'grace@smartypants.ai', federated_claims: { connector_id: 'google', user_id: 'sentinel-sub' } };
  const f = await fixture({ claims });
  try {
    await f.publish({ principals: [...policy.principals, { name: 'Grace', email: 'grace@smartypants.ai' }] });
    await f.start(); await f.login();
    const before = storedRows(f);
    delete claims.email; delete claims.federated_claims;
    const [model, when] = stage.split('.');
    const hook = f.human.auth.options.databaseHooks[model].create;
    const original = hook[when];
    let reached = false;
    hook[when] = async (...args) => {
      if (original) await original(...args);
      reached = true;
      assert.equal(count(f, 'user'), before.user.length + (model === 'user' ? 0 : 1));
      assert.equal(count(f, 'account'), before.account.length + (model === 'session' ? 1 : 0));
      assert.equal(count(f, 'session'), before.session.length + (when === 'after' ? 1 : 0));
      if (refusal === 'false') return false;
      throw new APIError('FORBIDDEN', { code: 'fixture_denial', message: 'Fixture denial' });
    };
    const { response } = await f.login();
    assert.equal(reached, true);
    noSessionCookie(response);
    assert.notEqual(response.headers.get('location'), publicBase + '/');
    assert.deepEqual(storedRows(f), before);
  } finally { await f.close(); }
});

test('returning broker account removed before callback cannot update existing rows', async () => {
  const f = await fixture();
  try {
    await f.start(); await f.login();
    const before = storedRows(f);
    await f.publish({ principals: [] });
    const { response } = await f.login();
    noSessionCookie(response);
    assert.notEqual(response.headers.get('location'), publicBase + '/');
    assert.deepEqual(storedRows(f), before);
  } finally { await f.close(); }
});

test.each(['changed email collides with another user', 'different subject presents an existing email'])(
  'broker refuses identity collision: %s', async scenario => {
    const claims = {};
    const f = await fixture({ claims });
    try {
      await f.publish({ principals: [...policy.principals, { name: 'Grace', email: 'grace@smartypants.ai' }] });
      await f.start(); await f.login();
      claims.email = 'grace@smartypants.ai';
      claims.federated_claims = { connector_id: 'google', user_id: 'grace-sub' };
      await f.login();
      const before = storedRows(f);
      if (scenario === 'changed email collides with another user') {
        delete claims.federated_claims; // Ada's existing subject now claims Grace's email.
      } else {
        claims.email = 'ada@smartypants.ai';
        claims.federated_claims.user_id = 'unlinked-sub';
      }
      const { response } = await f.login();
      noSessionCookie(response);
      assert.notEqual(response.headers.get('location'), publicBase + '/');
      assert.deepEqual(storedRows(f), before, 'no relinking, profile mutation or token update');
    } finally { await f.close(); }
  });

test.each(['tampered', 'missing'])('broker refuses %s state through the exposed handler before exchange', async change => {
  const f = await fixture();
  try {
    await f.start();
    const callback = await f.beginLogin();
    if (change === 'tampered') callback.searchParams.set('state', callback.searchParams.get('state') + '-tampered');
    else callback.searchParams.delete('state');
    const exchanges = f.calls.filter(path => path === '/token').length;
    const response = await f.request('/api/auth/callback/google' + callback.search);
    noSessionCookie(response);
    assert.notEqual(response.headers.get('location'), publicBase + '/');
    for (const table of ['user', 'account', 'session']) assert.equal(count(f, table), 0);
    assert.equal(f.calls.filter(path => path === '/token').length, exchanges);
  } finally { await f.close(); }
});

test.each(['same callback', 'consumed code in a fresh state'])('broker refuses replay of %s through the exposed handler', async replay => {
  const f = await fixture();
  try {
    await f.start();
    const { callback } = await f.login();
    const before = storedRows(f);
    const exchanges = f.calls.filter(path => path === '/token').length;
    let repeated = callback;
    if (replay === 'consumed code in a fresh state') {
      repeated = await f.beginLogin();
      repeated.searchParams.set('code', callback.searchParams.get('code'));
    }
    const response = await f.request('/api/auth/callback/google' + repeated.search);
    noSessionCookie(response);
    assert.notEqual(response.headers.get('location'), publicBase + '/');
    assert.deepEqual(storedRows(f), before);
    assert.equal(f.calls.filter(path => path === '/token').length, exchanges + (replay === 'same callback' ? 0 : 1));
  } finally { await f.close(); }
});

test('simultaneous broker callbacks keep admission and transactions request-local', async () => {
  const claims = {};
  const f = await fixture({ claims });
  try {
    await f.publish({ principals: [...policy.principals, { name: 'Grace', email: 'grace@smartypants.ai' }] });
    await f.start();
    const first = await f.beginLogin(), firstCookie = f.cookie();
    claims.email = 'grace@smartypants.ai';
    claims.federated_claims = { connector_id: 'google', user_id: 'grace-sub' };
    const second = await f.beginLogin(), secondCookie = f.cookie();
    const responses = await Promise.all([
      f.request('/api/auth/callback/google' + first.search, undefined, firstCookie),
      f.request('/api/auth/callback/google' + second.search, undefined, secondCookie),
    ]);
    for (const response of responses) assert.equal(response.headers.get('location'), publicBase + '/');
    assert.equal(count(f, 'user'), 2); assert.equal(count(f, 'account'), 2); assert.equal(count(f, 'session'), 2);
    assert.deepEqual(f.database.prepare('SELECT account.accountId, user.email FROM account JOIN user ON account.userId = user.id ORDER BY account.accountId').all().map(row => ({ ...row })),
      [{ accountId: googleSub, email: 'ada@smartypants.ai' }, { accountId: 'grace-sub', email: 'grace@smartypants.ai' }]);
  } finally { await f.close(); }
});

test('broker OFF retains direct Google configuration even with an org policy path or stray broker keys', async () => {
  const f = await fixture();
  try {
    await f.start({ broker: null, googleClientId: 'direct-client', googleClientSecret: 'direct-secret', env: { SMARTY_CODE_ORG_CONFIG: '/missing-policy', SMARTY_HUMAN_AUTH_BROKER_CLIENT_ID: 'ignored' } });
    assert.deepEqual(f.human.auth.options.socialProviders.google, { clientId: 'direct-client', clientSecret: 'direct-secret', prompt: 'select_account', hd: 'smartypants.ai' });
    const response = await f.request('/api/auth/sign-in/social', { provider: 'google', callbackURL: publicBase + '/' });
    assert.equal(new URL((await response.json()).url).origin, 'https://accounts.google.com');
    assert.deepEqual(f.calls, []);
  } finally { await f.close(); }
});
