import { describe, expect, it } from 'vitest';
import { createBillingRole, registerBillingRoleRoute } from './billing-role.js';

const token = 'secret-token';
const base = { SMARTY_NODE_ORG_ID: 'org-smartypants', SMARTY_NODE_REGISTRY_URL: 'http://127.0.0.1:8791' };
// A registry stand-in with net-lead's examples: paul owns smartypants, kate is a member, an unknown login is 404.
const registry = (calls = []) => async (url, init) => {
  calls.push({ url: String(url), init });
  const u = new URL(url);
  if (u.pathname === '/v1/login') {
    const { subject } = JSON.parse(init.body);
    const id = { 'g-paul': 'sp-paul', 'g-kate': 'sp-kate' }[subject];
    return id ? Response.json({ smarty_id: id }) : new Response('', { status: 404 });
  }
  if (u.pathname === '/v1/placements') {
    const role = { 'sp-paul': 'owner', 'sp-kate': 'member' }[u.searchParams.get('smarty_id')];
    return Response.json([{ org: { id: 'org-smartypants', name: 'smartypants' }, member_role: role, node: 'smartypants' },
      { org: { id: 'org-other', name: 'other' }, member_role: 'owner', node: 'other' }]);
  }
  return new Response('', { status: 500 });
};

describe('billing role (smarty-net#136 L3)', () => {
  it('owner only for the owner of THIS Node\'s org; a member, an owner elsewhere, or an unknown login is not', async () => {
    const calls = [];
    const role = createBillingRole({ env: { ...base }, token, fetchImpl: registry(calls) });
    expect(await role.isOwner('g-paul')).toBe(true);
    expect(await role.isOwner('g-kate')).toBe(false); // member here; owner only of org-other
    expect(await role.isOwner('g-nobody')).toBe(false);
    expect(calls[0].init.headers.authorization).toBe('Bearer secret-token');
    expect(JSON.parse(calls[0].init.body)).toEqual({ issuer: 'https://accounts.google.com', subject: 'g-paul' });
  });

  it('no token, no org, a registry error or a timeout: never a link', async () => {
    expect(await createBillingRole({ env: { ...base }, token: '', fetchImpl: registry() }).isOwner('g-paul')).toBe(false);
    expect(await createBillingRole({ env: { ...base, SMARTY_NODE_ORG_ID: '' }, token, fetchImpl: registry() }).isOwner('g-paul')).toBe(false);
    expect(await createBillingRole({ env: { ...base }, token, fetchImpl: async () => new Response('', { status: 503 }) }).isOwner('g-paul')).toBe(false);
    expect(await createBillingRole({ env: { ...base }, token, fetchImpl: async () => { throw new Error('down'); } }).isOwner('g-paul')).toBe(false);
  });

  it('the answer is cached briefly per person, then read again', async () => {
    let t = 0; const calls = [];
    const role = createBillingRole({ env: { ...base }, token, fetchImpl: registry(calls), now: () => t });
    await role.isOwner('g-paul'); await role.isOwner('g-paul');
    expect(calls.length).toBe(2); // login + placements once
    t = 5 * 60_000; await role.isOwner('g-paul');
    expect(calls.length).toBe(4);
  });

  it('the route: links only for the owner; nothing when signed out; the token never in the answer', async () => {
    const routes = new Map(); const app = { get: (p, h) => routes.set(p, h) };
    const account = { 'u-paul': 'g-paul', 'u-kate': 'g-kate' };
    const humanAuth = (user) => ({ resolve: async () => user && { user: { id: user } },
      auth: { $context: Promise.resolve({ adapter: { findOne: async ({ where }) => ({ accountId: account[where[0].value] }) } }) } });
    const run = async (user) => {
      routes.clear(); registerBillingRoleRoute(app, humanAuth(user), { billingRole: createBillingRole({ env: { ...base }, token, fetchImpl: registry() }) });
      let status = 200, body; const res = { set() {}, status(s) { status = s; return this; }, json(b) { body = b; } };
      await routes.get('/api/smarty/billing')({}, res);
      return { status, body };
    };
    expect(await run('u-paul')).toEqual({ status: 200, body: { owner: true, checkout: 'https://billing.smartypants.ai/checkout', portal: 'https://billing.smartypants.ai/portal' } });
    expect(await run('u-kate')).toEqual({ status: 200, body: { owner: false } });
    expect(await run(null)).toEqual({ status: 401, body: { owner: false } });
    expect(JSON.stringify(await run('u-paul'))).not.toContain('secret-token');
  });
});
