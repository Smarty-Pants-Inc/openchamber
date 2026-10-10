import assert from 'node:assert/strict';
import { test } from 'vitest';
import { EventEmitter } from 'node:events';
import { fixture, record, member, googleSubject, request, response } from './human-member-fixture.js';
import { collectForwardProxyHeaders } from '../../proxy-headers.js';
import { createUiAuth } from './ui-auth.js';

const refusals = {
  unknown: data => { data.logins = []; },
  ambiguous: data => { data.logins.push({ ...data.logins[0] }); },
  removed: data => { data.orgs[0].members[0].status = 'removed'; },
  suspended: data => { data.orgs[0].members[0].status = 'suspended'; },
  untrusted: data => { data.node.trusted_issuers = []; },
  'other issuer': data => { data.logins[0].issuer = 'https://attacker.test'; },
  'other org': data => { data.orgs[0].members = []; },
  'non-person': data => { data.orgs[0].members[0].kind = 'agent'; },
  'duplicate membership': data => { data.orgs[0].members.push({ ...data.orgs[0].members[0] }); },
  'two primary orgs': data => { data.orgs.push({ ...data.orgs[0], id: 'another-org' }); },
  'invalid node id': data => { data.node.id = '../node'; },
  'wrong node': data => { data.node.id = 'other-node'; },
  'invalid org id': data => { data.orgs[0].id = 'Org'; },
  'invalid member id': data => { data.logins[0].smarty_id = data.orgs[0].members[0].smarty_id = 'bad/member'; },
};

for (const [name, change] of Object.entries(refusals)) test(`Record B refuses ${name} on real Better Auth sessions`, async () => {
  const f = await fixture();
  try {
    const data = record(); change(data); await f.publish(data);
    assert.equal(await f.human.resolve(request(f.headers)), null);
    const res = response(); await f.human.status(request(f.headers), res);
    assert.equal(res.result().status, 401);
    let effects = 0;
    await f.human.protect(request(f.headers), response(), () => { effects++; });
    assert.equal(effects, 0, 'refusal precedes downstream/native effects');
  } finally { await f.close(); }
});

test('active member binds private forwarding without changing public actors or preference subjects', async () => {
  const f = await fixture();
  try {
    const session = await f.human.resolve(request(f.headers));
    assert.ok(session);
    const display = { version: 1, issuer: f.human.auth.options.baseURL, subject: f.user.id,
      name: 'Person', email: 'person@example.test' };
    assert.deepEqual(f.human.actor(session), display);
    assert.equal(Object.hasOwn(session, 'member'), false);
    assert.equal(Object.hasOwn(session.user, 'member'), false);
    const identity = f.human.actor(session, { forwarded: true });
    assert.equal(identity.issuer, f.human.auth.options.baseURL);
    assert.equal(identity.subject, f.user.id);
    assert.notEqual(identity.subject, googleSubject);
    assert.deepEqual(identity.member, member);
    assert.equal(Object.hasOwn(identity.member, 'kind'), false, 'public member shape is fixed');
    const forged = { ...session, member, user: { ...session.user, member } };
    assert.equal(Object.hasOwn(f.human.actor(forged, { forwarded: true }), 'member'), false);
    identity.member.smartyId = 'forged';
    assert.deepEqual(f.human.actor(session, { forwarded: true }).member, member, 'actor callers cannot mutate admitted binding');
    const res = response(); await f.human.status(request(f.headers), res);
    assert.deepEqual(res.result().body, { authenticated: true, humanAuth: true, user: display });
    const uiAuth = createUiAuth({ humanAuth: f.human });
    assert.deepEqual((await uiAuth.resolveAuthContext(request(f.headers))).user, display);
    const stream = new EventEmitter(); stream.destroy = () => stream.emit('close');
    const req = request(f.headers); let effects = 0;
    await f.human.protect(req, stream, () => { effects++; });
    assert.equal(effects, 1); assert.deepEqual(req.humanIdentity.member, member);
    const forwarded = collectForwardProxyHeaders({ 'x-smarty-human-identity': 'forged', cookie: 'private' },
      { Authorization: 'Bearer fixture-private-edge' }, req.humanIdentity);
    assert.equal(Object.hasOwn(forwarded, 'cookie'), false);
    assert.deepEqual(JSON.parse(Buffer.from(forwarded['x-smarty-human-identity'], 'base64url').toString()),
      { ...display, member });
    const sidebar = await f.human.sidebarView({ ...req, method: 'GET' });
    assert.deepEqual(sidebar, { owner: { issuer: display.issuer, subject: display.subject }, projects: {}, groups: {} });
    assert.equal(JSON.stringify(sidebar).includes(googleSubject), false);
    assert.equal(JSON.stringify(res.result()).includes(googleSubject), false);
    assert.equal(await f.human.authorizeUiSession(`human:${session.session.id}`), true);
  } finally { await f.close(); }
});

test('fresh lookup withdraws ongoing group admission, not just the next HTTP request', async () => {
  const f = await fixture();
  try {
    const session = await f.human.resolve(request(f.headers));
    const group = `human:${session.session.id}`;
    assert.equal(await f.human.authorizeUiSession(group), true);
    const data = record(); data.orgs[0].members[0].status = 'removed'; await f.publish(data);
    assert.equal(await f.human.authorizeUiSession(group), false);
    assert.equal(await f.human.resolve(request(f.headers)), null);
    await f.publish(record());
    assert.deepEqual(f.human.actor(await f.human.resolve(request(f.headers)), { forwarded: true }).member, member);
    await f.human.auth.api.signOut({ headers: f.headers });
    assert.equal(await f.human.authorizeUiSession(group), false);
  } finally { await f.close(); }
});

test('Google account recovery rejects zero or multiple rows, never picks the first', async () => {
  const f = await fixture();
  try {
    await f.adapter.create({ model: 'account', data: { userId: f.user.id, providerId: 'github', accountId: 'unrelated',
      createdAt: new Date(), updatedAt: new Date() } });
    assert.deepEqual(f.human.actor(await f.human.resolve(request(f.headers)), { forwarded: true }).member, member);
    await f.adapter.create({ model: 'account', data: { userId: f.user.id, providerId: 'google', accountId: 'second-google',
      createdAt: new Date(), updatedAt: new Date() } });
    assert.equal(await f.human.resolve(request(f.headers)), null);
    await f.adapter.deleteMany({ model: 'account', where: [{ field: 'providerId', value: 'google' }] });
    assert.equal(await f.human.resolve(request(f.headers)), null);
  } finally { await f.close(); }
});

test('explicit org selection needs exactly one matching org and uses that membership', async () => {
  const f = await fixture({ extraEnv: { SMARTY_NODE_ORG_ID: 'second-org' } });
  try {
    const data = record(); data.orgs.push({ ...data.orgs[0], id: 'second-org', placement: 'other' });
    await f.publish(data);
    assert.deepEqual(f.human.actor(await f.human.resolve(request(f.headers)), { forwarded: true }).member,
      { ...member, orgId: 'second-org' });
    data.orgs.push({ ...data.orgs[1] }); await f.publish(data);
    assert.equal(await f.human.resolve(request(f.headers)), null);
  } finally { await f.close(); }
});

test('unconfigured human auth neither binds a member nor requires Google account recovery', async () => {
  const f = await fixture({ configured: false });
  try {
    await f.adapter.deleteMany({ model: 'account', where: [] });
    const session = await f.human.resolve(request(f.headers));
    assert.ok(session); assert.equal(Object.hasOwn(f.human.actor(session), 'member'), false);
    assert.equal(await f.human.authorizeUiSession(`human:${session.session.id}`), true);
  } finally { await f.close(); }
});
