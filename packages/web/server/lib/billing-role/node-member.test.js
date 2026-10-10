import assert from 'node:assert/strict';
import { test } from 'vitest';
import { resolveNodeMember } from './node-member.js';
import { record, member, googleSubject } from '../ui-auth/human-member-fixture.js';

const resolve = data => resolveNodeMember(data, googleSubject, { nodeId: member.nodeId });

test('pure member resolver rejects duplicate bindings, non-people, untrusted issuers and wrong org selection', () => {
  const cases = [
    data => { data.logins.push({ ...data.logins[0] }); },
    data => { data.logins.push({ ...data.logins[0], smarty_id: 'other-person' }); },
    data => { data.orgs[0].members.push({ ...data.orgs[0].members[0], status: 'removed' }); },
    data => { data.orgs.push({ ...data.orgs[0], placement: 'other' }); },
    data => { data.orgs[0].members[0].kind = 'agent'; },
    data => { delete data.orgs[0].members[0].kind; },
    data => { data.node.trusted_issuers = ['https://accounts.google.com/']; },
    data => { data.logins[0].issuer = 'accounts.google.com'; },
    data => { data.orgs[0].placement = 'other'; },
  ];
  for (const change of cases) {
    const data = record(); change(data); assert.equal(resolve(data), null);
  }
  assert.equal(resolveNodeMember(record(), googleSubject, { orgId: 'missing' }), null);
  assert.deepEqual(resolve(record()), { member, role: 'owner' });
});

test('registry IDs stay lower-case, bounded and safe, including the final-newline regex edge', () => {
  for (const id of ['', 'Upper', '../member', 'two words', 'member\n', 'n'.repeat(64)]) {
    for (const field of ['node', 'org', 'member']) {
      const data = record();
      if (field === 'node') data.node.id = id;
      if (field === 'org') data.orgs[0].id = id;
      if (field === 'member') data.logins[0].smarty_id = data.orgs[0].members[0].smarty_id = id;
      assert.throws(() => resolve(data), /Unsupported Node member record/);
    }
  }
  const data = record(), max = 'n'.repeat(63);
  data.node.id = data.orgs[0].id = data.orgs[0].members[0].smarty_id = data.logins[0].smarty_id = max;
  assert.deepEqual(resolveNodeMember(data, googleSubject).member, { nodeId: max, orgId: max, smartyId: max, googleSubject });
});

test('only exact bounded Google subjects can become forwarded claims, never emails', () => {
  for (const subject of ['', 'person@example.test', 'bad/subject', 'subject\n', 'g'.repeat(257), null, 123]) {
    const data = record(); data.logins[0].subject = String(subject);
    assert.equal(resolveNodeMember(data, subject), null);
  }
  const data = record(), subject = 'g'.repeat(256); data.logins[0].subject = subject;
  assert.equal(resolveNodeMember(data, subject).member.googleSubject, subject);
});
