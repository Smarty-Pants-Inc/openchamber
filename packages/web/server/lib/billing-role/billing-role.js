// smarty-net#136 L3: whether the signed-in person owns this Node's org, so the page shows "Add credit" and "Manage plan"
// only to the owner. The Node registry answers (net-lead): POST /v1/login {issuer, subject} -> {smarty_id};
// GET /v1/placements?smarty_id=... -> [{org:{id,name}, member_role, node}]. The subject is the person's Google account id.
// The registry token stays in this server's environment (from the credential profile the service is started with); it
// never reaches argv, a file, a log or the page. Billing itself authorizes again, so a stale "owner" only shows a link
// the billing page then refuses.
const GOOGLE_ISSUER = 'https://accounts.google.com';
const CACHE_MS = 5 * 60_000;
const TIMEOUT_MS = 5_000;

export function createBillingRole({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  const registry = (env.SMARTY_NODE_REGISTRY_URL || 'http://127.0.0.1:8791').replace(/\/+$/, '');
  const orgId = env.SMARTY_NODE_ORG_ID || '';
  const billing = (env.SMARTY_BILLING_URL || 'https://billing.smartypants.ai').replace(/\/+$/, '');
  const cache = new Map();
  const call = async (path, init = {}) => {
    const token = env.NODE_REGISTRY_TOKEN;
    if (!token) throw new Error('no registry token');
    const response = await fetchImpl(`${registry}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}`, accept: 'application/json' } });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`registry ${response.status}`);
    return response.json();
  };
  /** True only when the registry says this Google account owns the Node's org; any failure or doubt is false. */
  const isOwner = async (googleAccountId) => {
    if (!orgId || !env.NODE_REGISTRY_TOKEN || !googleAccountId) return false;
    const hit = cache.get(googleAccountId);
    if (hit && now() - hit.at < CACHE_MS) return hit.owner;
    let owner = false;
    try {
      const login = await call('/v1/login', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ issuer: GOOGLE_ISSUER, subject: googleAccountId }) });
      const smartyId = String(login?.smarty_id ?? '');
      if (smartyId) {
        const placements = await call(`/v1/placements?smarty_id=${encodeURIComponent(smartyId)}`);
        owner = Array.isArray(placements) && placements.some((p) => p?.org?.id === orgId && p?.member_role === 'owner');
      }
    } catch { owner = false; } // Never a link on doubt; the reason is not logged (it could carry the request).
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
      return res.json({ owner: false });
    }
  });
}
