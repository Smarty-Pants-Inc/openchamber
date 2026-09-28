// smarty-net#136 L3: whether the signed-in person owns this Node's org, so the page shows "Add credit" and "Manage plan"
// only to the owner. The answer comes from the Node's published registry record ("Record B", node-registry publish:
// <node inbox>/registry.json, format 1): the orgs placed on this Node with their members' roles, and the logins
// {issuer, subject, smarty_id}. No credential and no network call: nothing here can leak. Freshness is the registry's
// publish cadence (every registry change republishes the file); a stale role only shows or hides a link that billing
// authorizes again. The login is matched on the exact (issuer, subject) of the person's verified Google account.
import { readFile } from 'node:fs/promises';

const GOOGLE_ISSUER = 'https://accounts.google.com';

/** The owner check. `record`: the registry.json path (SMARTY_NODE_RECORD); unset, nobody is shown billing links. */
export function createBillingRole({ env = process.env, read = readFile } = {}) {
  const record = env.SMARTY_NODE_RECORD || '';
  const billing = (env.SMARTY_BILLING_URL || 'https://billing.smartypants.ai').replace(/\/+$/, '');
  /** True when the record names this Google account an active owner of the Node's org; false when it says otherwise.
   * A missing, unreadable or unknown-format record throws: it is not an answer, so the route answers 503. */
  const isOwner = async (googleAccountId) => {
    if (!record || !googleAccountId) return false;
    const data = JSON.parse(await read(record, 'utf8'));
    if (data?.format !== 1 || !Array.isArray(data.orgs) || !Array.isArray(data.logins)) throw new Error('unsupported Node record');
    const org = env.SMARTY_NODE_ORG_ID ? data.orgs.find((o) => o?.id === env.SMARTY_NODE_ORG_ID)
      : data.orgs.find((o) => o?.placement === 'primary');
    const ids = new Set(data.logins.filter((l) => l?.issuer === GOOGLE_ISSUER && l?.subject === googleAccountId).map((l) => l.smarty_id));
    return Array.isArray(org?.members) && org.members.some((m) => ids.has(m?.smarty_id) && m.role === 'owner' && m.status === 'active');
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
      // Not an answer (the record or the sign-in store failed): 503, so the page shows no link and asks again later;
      // never an error shown to the person, and no reason logged or returned.
      return res.status(503).json({ owner: false });
    }
  });
}
