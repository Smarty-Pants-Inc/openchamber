import { describe, expect, it } from 'vitest';
import { createBillingRole, registerBillingRoleRoute } from './billing-role.js';

// smarty-net#136 L3: the owner check reads the Node's published registry record (Record B, format 1).
const G = 'https://accounts.google.com';
const record = (over = {}) => JSON.stringify({ format: 1, revision: 41,
  node: { id: 'test-node', trusted_issuers: [G] },
  orgs: [{ id: 'smartypants', name: 'smartypants', placement: 'primary', members: [
    { smarty_id: 'sp-paul', kind: 'person', role: 'owner', status: 'active' },
    { smarty_id: 'sp-kate', kind: 'person', role: 'member', status: 'active' },
    { smarty_id: 'sp-old', kind: 'person', role: 'owner', status: 'removed' }] },
  { id: 'other', name: 'other', placement: 'other', members: [
    { smarty_id: 'sp-kate', kind: 'person', role: 'owner', status: 'active' }] }],
  logins: [{ issuer: G, subject: 'g-paul', smarty_id: 'sp-paul' }, { issuer: G, subject: 'g-kate', smarty_id: 'sp-kate' },
    { issuer: G, subject: 'g-old', smarty_id: 'sp-old' }, { issuer: 'https://other.example', subject: 'g-kate-2', smarty_id: 'sp-paul' }],
  ...over });
const env = { SMARTY_NODE_RECORD: '/node/registry.json' };
const role = (text, extra = {}) => createBillingRole({ env: { ...env, ...extra }, read: async () => { if (text instanceof Error) throw text; return text; } });

describe('billing role from the Node record (smarty-net#136 L3)', () => {
  it('owner only for an active owner of the primary org, matched on the exact Google (issuer, subject)', async () => {
    expect(await role(record()).isOwner('g-paul')).toBe(true);
    expect(await role(record()).isOwner('g-kate')).toBe(false); // a member here; an owner only of another org
    expect(await role(record()).isOwner('g-old')).toBe(false); // a removed owner
    expect(await role(record()).isOwner('g-kate-2')).toBe(false); // the right subject under another issuer does not count
    expect(await role(record()).isOwner('g-nobody')).toBe(false);
    expect(await role(record(), { SMARTY_NODE_ORG_ID: 'other' }).isOwner('g-kate')).toBe(true); // an explicit org
  });

  it('no record configured: nobody gets links; a missing, broken or unknown-format record is not an answer (throws)', async () => {
    expect(await createBillingRole({ env: {}, read: async () => { throw new Error('never read'); } }).isOwner('g-paul')).toBe(false);
    await expect(role(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })).isOwner('g-paul')).rejects.toThrow();
    await expect(role('{not json').isOwner('g-paul')).rejects.toThrow();
    await expect(role(record({ format: 2 })).isOwner('g-paul')).rejects.toThrow();
  });

  it('the route: links only for the owner; nothing when signed out; 503 while the record is unreadable, links after', async () => {
    const routes = new Map(); const app = { get: (p, h) => routes.set(p, h) };
    const account = { 'u-paul': 'g-paul', 'u-kate': 'g-kate' };
    const humanAuth = (user) => ({ resolve: async () => user && { user: { id: user } },
      auth: { $context: Promise.resolve({ adapter: { findMany: async ({ where }) => [{ accountId: account[where[0].value] }] } }) } });
    const run = async (user, billingRole) => {
      routes.clear(); registerBillingRoleRoute(app, humanAuth(user), { billingRole });
      let status = 200, body; const res = { set() {}, status(s) { status = s; return this; }, json(b) { body = b; } };
      await routes.get('/api/smarty/billing')({}, res);
      return { status, body };
    };
    expect(await run('u-paul', role(record()))).toEqual({ status: 200, body: { owner: true, checkout: 'https://billing.smartypants.ai/checkout', portal: 'https://billing.smartypants.ai/portal' } });
    expect(await run('u-kate', role(record()))).toEqual({ status: 200, body: { owner: false } });
    expect(await run(null, role(record()))).toEqual({ status: 401, body: { owner: false } });
    let text = new Error('ENOENT');
    const recovering = createBillingRole({ env, read: async () => { if (text instanceof Error) throw text; return text; } });
    expect(await run('u-paul', recovering)).toEqual({ status: 503, body: { owner: false } });
    text = record(); expect((await run('u-paul', recovering)).body.owner).toBe(true);
  });
});
