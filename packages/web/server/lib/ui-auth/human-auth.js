import { startWebTiming } from './web-timing.js';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { getMigrations } from 'better-auth/db/migration';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { createHumanAudience } from './human-audience.js';
import { createNodeMembership } from './node-membership.js';

export const MEMBERSHIP_CHECK_MS = 2_000;
/** Better Auth owns accounts and sessions. The caller owns the private database and activation. */
export async function createHumanAuth({ database, baseURL, secret, googleClientId, googleClientSecret, allowedDomains, nodeRecord }) {
  const inAudience = createHumanAudience(allowedDomains);
  // smarty-net#117 N2: on a Node, only its members (by their Google subject in the Node's record). Without a record: as before.
  const member = nodeRecord ? createNodeMembership(nodeRecord) : undefined;
  const googleSubjects = new Map();
  const googleSubject = async (userId) => {
    if (googleSubjects.has(userId)) return googleSubjects.get(userId);
    const { adapter } = await auth.$context;
    const account = await adapter.findOne({ model: 'account', where: [{ field: 'userId', value: userId }, { field: 'providerId', value: 'google' }],
      select: ['accountId'] });
    if (account?.accountId) googleSubjects.set(userId, account.accountId);
    return account?.accountId;
  };
  const admits = async (user) => inAudience(user) && (!member || Boolean(user?.id && await member(await googleSubject(user.id))));
  const hostedDomain = allowedDomains.length === 1 && typeof allowedDomains[0] === 'string'
    ? allowedDomains[0].toLowerCase() : null;
  if (!hostedDomain) throw new Error('Human authentication requires one exact Google Workspace domain');
  const origin = new URL(baseURL);
  if (origin.origin !== baseURL || !['https:', 'http:'].includes(origin.protocol)
    || (origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) {
    throw new Error('Human authentication requires an exact HTTPS origin or loopback test origin');
  }
  if (!database || typeof secret !== 'string' || secret.length < 32 || !googleClientId || !googleClientSecret) {
    throw new Error('Human authentication configuration is incomplete');
  }
  const liveResponses = new Map(), sessionUsers = new Map(); // sessionUsers: each live session's user (membership recheck).
  const closeSession = (id) => {
    for (const response of liveResponses.get(id) || []) response.destroy();
    liveResponses.delete(id);
  };
  const deny = () => { throw new APIError('FORBIDDEN', { message: 'This account is not allowed to use this instance' }); };
  const options = {
    database, baseURL, secret,
    trustedOrigins: [baseURL],
    advanced: { disableOriginCheck: false, disableCSRFCheck: false },
    emailAndPassword: { enabled: false },
    socialProviders: { google: {
      clientId: googleClientId, clientSecret: googleClientSecret, prompt: 'select_account', hd: hostedDomain,
    } },
    account: { accountLinking: { enabled: false } },
    user: {
      changeEmail: { enabled: false },
      validateUserInfo: async ({ user, source }) => {
        const profile = source.oauth?.profile;
        if (source.method !== 'oauth' || source.oauth?.providerId !== 'google'
          || profile?.hd !== hostedDomain || !inAudience(user) || (member && !await member(profile?.sub))) {
          return { error: 'account_not_allowed', errorDescription: 'This account is not allowed to use this instance' };
        }
      },
    },
    session: {
      cookieCache: { enabled: false },
      additionalFields: { workspacePolicy: { type: 'string', required: false, input: false, returned: false } },
    },
    databaseHooks: {
      user: {
        create: { before: async (user) => { if (!inAudience(user)) deny(); } }, // Membership: validateUserInfo, then each session.
        update: { before: async (user) => {
          if (user.email !== undefined || user.emailVerified !== undefined) deny();
          if (user.name !== undefined && !validName(user.name)) {
            throw new APIError('BAD_REQUEST', { message: 'Invalid profile name' });
          }
          if (user.image !== undefined && user.image !== null && user.image !== '' && !validImage(user.image)) {
            throw new APIError('BAD_REQUEST', { message: 'Invalid profile image' });
          }
        } },
      },
      session: {
        create: { before: async (session, context) => {
          const runtime = context?.context ?? await auth.$context;
          const user = await runtime.internalAdapter.findUserById(session.userId);
          if (!await admits(user)) deny();
          return { data: { ...session, workspacePolicy: `google-hd:${hostedDomain}` } };
        } },
        delete: { after: async (session) => { closeSession(session.id); } },
      },
    },
  };
  // On a Node, every open stream and socket (SSE, terminal, voice) is rechecked against the record every
  // MEMBERSHIP_CHECK_MS: a withdrawn member's connections are closed, so no further input or output passes (#326 review).
  const membershipCheck = member ? setInterval(() => { void (async () => {
    for (const [id, user] of sessionUsers) if (!await admits(user).catch(() => false)) {
      console.warn(JSON.stringify({ type: 'smarty.node-member-withdrawn', session: id.slice(0, 8) })); closeSession(id); sessionUsers.delete(id);
    }
  })(); }, MEMBERSHIP_CHECK_MS) : undefined;
  membershipCheck?.unref?.();
  // Use the library's schema, not a second hand-maintained account schema.
  const migration = await getMigrations(options);
  await migration.runMigrations();
  const auth = betterAuth(options);
  const { adapter } = await auth.$context;
  // No default/backfill: old email-only sessions are not evidence of Workspace admission.
  for (const where of [
    [{ field: 'workspacePolicy', value: null }],
    [{ field: 'workspacePolicy', operator: 'ne', value: `google-hd:${hostedDomain}` }],
  ]) {
    if (await adapter.findOne({ model: 'session', where: [
      ...where, { field: 'expiresAt', operator: 'gt', value: new Date() },
    ] })) {
      throw new Error('Human auth activation blocked: revoke prior-policy sessions through the owner-controlled migration, then require Google reauthentication');
    }
  }
  const resolve = async (req) => {
    // Device bearer credentials do not become people through an ambient cookie.
    if (req.headers.authorization) return null;
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers), query: { disableCookieCache: true } });
    if (!session || !await admits(session.user)) return null; // A removed member is refused at the next request.
    return session;
  };
  const actor = (session) => {
    const identity = {
      version: 1, issuer: baseURL, subject: session.user.id,
      name: validName(session.user.name) ? session.user.name : 'User',
    };
    if (validImage(session.user.image)) identity.image = session.user.image;
    // smarty-code#701: the admitted (verified, allowed-domain) email names the person's inbox. The gateway must accept
    // it (installed first) and never copy it into message metadata.
    identity.email = session.user.email;
    return identity;
  };
  const authorizeUiSession = async (groupKey) => {
    if (typeof groupKey !== 'string' || !/^human:[A-Za-z0-9_-]{1,128}$/.test(groupKey)) return false;
    try {
      const { adapter } = await auth.$context;
      const session = await adapter.findOne({ model: 'session', where: [{ field: 'id', value: groupKey.slice(6) }],
        select: ['id', 'userId', 'expiresAt'] });
      if (!session || new Date(session.expiresAt).getTime() <= Date.now()) return false;
      const user = await adapter.findOne({ model: 'user', where: [{ field: 'id', value: session.userId }],
        select: ['id', 'email', 'emailVerified'] });
      if (!await admits(user)) return false;
      const current = await adapter.findOne({ model: 'session', where: [{ field: 'id', value: session.id }],
        select: ['userId', 'expiresAt'] });
      return current?.userId === session.userId && new Date(current.expiresAt).getTime() > Date.now();
    } catch { return false; }
  };
  const unauthorized = (res) => res.status(401).json({ authenticated: false, locked: true, humanAuthRequired: true });
  const protect = async (req, res, next, reject = unauthorized) => {
    const checked = startWebTiming(req); // smarty-code#827: the web server's share of a request, forwarded to Code.
    const session = await resolve(req);
    if (!session) return reject(res);
    const responses = liveResponses.get(session.session.id) || new Set();
    liveResponses.set(session.session.id, responses); sessionUsers.set(session.session.id, session.user);
    responses.add(res);
    // Session expiry also closes already-open streams, not just later HTTP requests.
    const remaining = new Date(session.session.expiresAt).getTime() - Date.now();
    if (remaining <= 0) { closeSession(session.session.id); return; }
    const timer = setTimeout(() => res.destroy(), Math.min(remaining, 2_147_483_647));
    timer.unref?.();
    let closed = false;
    const cleanup = () => {
      closed = true;
      clearTimeout(timer); responses.delete(res);
      if (!responses.size) { liveResponses.delete(session.session.id); sessionUsers.delete(session.session.id); }
    };
    res.once('close', cleanup);
    res.once('finish', cleanup);
    // Register before rechecking so deletion cannot fall between admission and tracking.
    const current = await resolve(req);
    if (closed || res.destroyed || res.writableEnded || !current || current.session.id !== session.session.id) {
      cleanup(); res.destroy(); return;
    }
    checked();
    req.humanIdentity = actor(current);
    return next();
  };
  return {
    auth,
    handler: toNodeHandler(auth),
    resolve,
    protect,
    actor,
    authorizeUiSession,
    status: async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const session = await resolve(req);
      return session ? res.json({ authenticated: true, humanAuth: true, user: actor(session) }) : unauthorized(res);
    },
    dispose: () => { clearInterval(membershipCheck); for (const id of liveResponses.keys()) closeSession(id); },
  };
}

function validName(value) {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 128
    && !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069<>]/u.test(value);
}
function validImage(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }
  catch { return false; }
}
