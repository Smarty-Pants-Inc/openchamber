import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { betterAuth } from 'better-auth';
import { testUtils } from 'better-auth/plugins';
import { createNodeMembership } from './node-membership.js';
import { createHumanAuth, MEMBERSHIP_CHECK_MS } from './human-auth.js';
import { EventEmitter } from 'node:events';

// smarty-net#117 N2: on a Node, only its members sign in, by their Google subject in the Node's registry record.
const GOOGLE = 'https://accounts.google.com';
const record = (members, logins, extra = {}) => ({ format: 1, revision: 1, node: { id: 'test-org', trusted_issuers: [GOOGLE] },
  orgs: [{ id: 'org', members }], logins, ...extra });
const withRecord = (value, run) => {
  const dir = mkdtempSync(join(tmpdir(), 'node-record-')), path = join(dir, 'registry.json');
  if (value !== undefined) writeFileSync(path, JSON.stringify(value));
  return Promise.resolve(run(path)).finally(() => rmSync(dir, { recursive: true, force: true }));
};

test('an active person member by Google subject; not by email, not suspended, not an agent, not an untrusted issuer', () => withRecord(record(
  [{ smarty_id: 'kate', kind: 'person', status: 'active' }, { smarty_id: 'gone', kind: 'person', status: 'suspended' },
    { smarty_id: 'bot', kind: 'org_agent', status: 'active' }],
  [{ issuer: GOOGLE, subject: '111', smarty_id: 'kate' }, { issuer: GOOGLE, subject: '222', smarty_id: 'gone' },
    { issuer: GOOGLE, subject: '333', smarty_id: 'bot' }, { issuer: 'https://other.example', subject: '444', smarty_id: 'kate' }]), async (path) => {
  const member = createNodeMembership(path);
  assert.equal(await member('111'), 'kate');
  for (const subject of ['222', '333', '444', 'kate@example.test', '', undefined]) assert.equal(await member(subject), undefined);
}));

test('fails closed: no record, an invalid record, or a record that does not trust Google admits nobody', async () => {
  await withRecord(undefined, async (path) => assert.equal(await createNodeMembership(path)('111'), undefined));
  await withRecord({ format: 2 }, async (path) => assert.equal(await createNodeMembership(path)('111'), undefined));
  await withRecord(record([{ smarty_id: 'kate', kind: 'person', status: 'active' }], [{ issuer: GOOGLE, subject: '111', smarty_id: 'kate' }],
    { node: { id: 'test-org', trusted_issuers: [] } }), async (path) => assert.equal(await createNodeMembership(path)('111'), undefined));
});

// #326 review: a malformed format-1 record admits nobody (not only format 2).
test('a malformed format-1 record admits nobody: a non-string id, a member without an id, an unknown field, a bad status', async () => {
  const kate = { smarty_id: 'kate', kind: 'person', status: 'active' }, login = { issuer: GOOGLE, subject: '111', smarty_id: 'kate' };
  const cases = [
    record([{ smarty_id: 7, kind: 'person', status: 'active' }], [{ issuer: GOOGLE, subject: '111', smarty_id: 7 }]),
    record([kate, { kind: 'person', status: 'active' }], [login]),
    record([{ ...kate, admin: true }], [login]),
    record([kate], [{ ...login, extra: 1 }]),
    record([{ ...kate, status: 'maybe' }], [login]),
    { ...record([kate], [login]), unexpected: 1 },
    record([kate], [login], { node: { trusted_issuers: [GOOGLE] } }), // node.id missing
  ];
  for (const value of cases) await withRecord(value, async (path) => assert.equal(await createNodeMembership(path)('111'), undefined));
  await withRecord(record([kate], [login]), async (path) => assert.equal(await createNodeMembership(path)('111'), 'kate')); // Valid.
});

test('a member removed from the record is refused at the next request, and their open connections are closed', () => withRecord(record(
  [{ smarty_id: 'kate', kind: 'person', status: 'active' }], [{ issuer: GOOGLE, subject: '111', smarty_id: 'kate' }]), async (path) => {
  const database = new DatabaseSync(':memory:');
  const human = await createHumanAuth({ baseURL: 'http://localhost:43210', secret: 'fixture-only-secret-at-least-thirty-two-characters',
    googleClientId: 'c', googleClientSecret: 's', allowedDomains: ['example.test'], database, nodeRecord: path });
  try {
    const testAuth = betterAuth({ ...human.auth.options, user: { ...human.auth.options.user, validateUserInfo: undefined }, plugins: [testUtils()] });
    const helpers = (await testAuth.$context).test;
    const user = await helpers.saveUser(helpers.createUser({ name: 'Kate', email: 'kate@example.test', emailVerified: true }));
    const { adapter } = await human.auth.$context;
    await adapter.create({ model: 'account', data: { userId: user.id, providerId: 'google', accountId: '111', createdAt: new Date(), updatedAt: new Date() } });
    const headers = await helpers.getAuthHeaders({ userId: user.id });
    const request = { headers: Object.fromEntries(headers) };
    assert.equal((await human.resolve(request))?.user.id, user.id); // A member.
    // #326 review: an open stream or socket (SSE, terminal, voice) of that session stays open while a member...
    const socket = new EventEmitter(); let destroyed = false, admitted = false;
    socket.destroy = () => { destroyed = true; socket.emit('close'); };
    await human.protect(request, socket, () => { admitted = true; });
    assert.equal(admitted, true);
    writeFileSync(path, JSON.stringify(record([], []))); // Removed from the Node.
    assert.equal(await human.resolve(request), null);
    // ...and is closed within the membership check's interval after withdrawal: no further frames in or out.
    await new Promise(done => setTimeout(done, MEMBERSHIP_CHECK_MS + 500));
    assert.equal(destroyed, true);
  } finally { human.dispose(); database.close(); }
}));
