// smarty-net#136 L3: whether the signed-in person owns this Node's org, so the page shows "Add credit" and "Manage plan"
// only to the owner. The Node registry answers (net-lead): POST /v1/login {issuer, subject} -> {smarty_id};
// GET /v1/placements?smarty_id=... -> [{org:{id,name}, member_role, node}]. The subject is the person's Google account id.
// The registry token (from the service's credential profile) is taken out of the environment when this module loads
// (registry-token.js), so it never reaches a child process, argv, a file, a log or the page. Billing itself authorizes
// again, so a stale "owner" only shows a link the billing page then refuses.
import { registryToken } from './registry-token.js';

const GOOGLE_ISSUER = 'https://accounts.google.com';
const CACHE_MS = 5 * 60_000;
const TIMEOUT_MS = 5_000;

export function createBillingRole({ env = process.env, token = registryToken(), fetchImpl = fetch, now = Date.now } = {}) {
  const registry = (env.SMARTY_NODE_REGISTRY_URL || 'http://127.0.0.1:8791').replace(/\/+$/, '');
  const orgId = env.SMARTY_NODE_ORG_ID || '';
  const billing = (env.SMARTY_BILLING_URL || 'https://billing.smartypants.ai').replace(/\/+$/, '');
  const cache = new Map();
  const call = async (path, init = {}) => {
    if (!token) throw new Error('no registry token');
    const response = await fetchImpl(`${registry}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}`, accept: 'application/json' } });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`registry ${response.status}`);
    return response.json();
  };
  /** True only when the registry says this Google account owns the Node's org, false when it says otherwise. A failed
   * lookup throws: it is not an answer, so it is never cached and the page asks again (it shows no link meanwhile). */
  const isOwner = async (googleAccountId) => {
    if (!orgId || !token || !googleAccountId) return false;
    const hit = cache.get(googleAccountId);
    if (hit && now() - hit.at < CACHE_MS) return hit.owner;
    const login = await call('/v1/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ issuer: GOOGLE_ISSUER, subject: googleAccountId }) });
    const smartyId = String(login?.smarty_id ?? '');
    let owner = false;
    if (smartyId) {
      const placements = await call(`/v1/placements?smarty_id=${encodeURIComponent(smartyId)}`);
      owner = Array.isArray(placements) && placements.some((p) => p?.org?.id === orgId && p?.member_role === 'owner');
    }
    cache.set(googleAccountId, { owner, at: now() });
    return owner;
  };
  return { isOwner, links: { checkout: `${billing}/checkout`, portal: `${billing}/portal` } };
}

/** GET /api/smarty/billing: {owner, checkout?, portal?} for the signed-in person; the links only for the owner. */
export function registerBillingRoleRoute(app, humanAuth, { env = process.env, billingRole = createBillingRole({ env }) } = {}) {
  app.get('/api/smarty/billing', async (req, res) => {
    res.set('cache-control', 'no-store');
    try {
      const session = await humanAuth.resolve(req);
      if (!session) return res.status(401).json({ owner: false });
      const { adapter } = await humanAuth.auth.$context;
      const account = await adapter.findOne({ model: 'account', where: [{ field: 'userId', value: session.user.id },
        { field: 'providerId', value: 'google' }], select: ['accountId'] });
      const owner = await billingRole.isOwner(account?.accountId);
      return res.json(owner ? { owner: true, ...billingRole.links } : { owner: false });
    } catch {
      // Not an answer (the registry or the sign-in store failed): 503, never a cached "not the owner"; no reason
      // is logged or returned (it could carry the request).
      return res.status(503).json({ owner: false });
    }
  });
}
