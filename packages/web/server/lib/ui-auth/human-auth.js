import { startWebTiming } from './web-timing.js';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { getMigrations } from 'better-auth/db/migration';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { createHumanAudience } from './human-audience.js';
import { createHumanSidebarView } from './human-sidebar-view.js';
import { createHumanMemberBinding } from './human-member.js';
import { createHumanConnectionLifetime } from './human-connection.js';

/** Better Auth owns accounts and sessions. The caller owns the private database and activation. */
export async function createHumanAuth({ database, baseURL, secret, googleClientId, googleClientSecret, allowedDomains,
  env = process.env }) {
  const admits = createHumanAudience(allowedDomains, { allowedEmailsFile: env.SMARTY_HUMAN_AUTH_ALLOWED_EMAILS_FILE });
  const members = createHumanMemberBinding(env);
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
  let connections;
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
      additionalFields: { sidebarPreferences: { type: 'string', required: false, input: false, returned: false } },
      changeEmail: { enabled: false },
      validateUserInfo: async ({ user, source }) => {
        const profile = source.oauth?.profile;
        if (source.method !== 'oauth' || source.oauth?.providerId !== 'google'
          || profile?.hd !== hostedDomain || !admits(user)) {
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
        create: { before: async (user) => { if (!admits(user)) deny(); } },
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
          if (!admits(user)) deny();
          return { data: { ...session, workspacePolicy: `google-hd:${hostedDomain}` } };
        } },
        delete: { after: async (session) => { connections?.closeSession(session.id); } },
      },
    },
  };
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
    try {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers), query: { disableCookieCache: true } });
      if (!session || !admits(session.user) || !await members.admit(adapter, session)
        || new Date(session.session.expiresAt).getTime() <= Date.now()) return null;
      return session;
    } catch { return null; } // Lookup failure is a refusal, never an admitted or guessed member.
  };
  connections = createHumanConnectionLifetime({ resolve, members, adapter, admits });
  const actor = (session, { forwarded = false } = {}) => {
    const identity = {
      version: 1, issuer: baseURL, subject: session.user.id,
      name: validName(session.user.name) ? session.user.name : 'User',
    };
    if (validImage(session.user.image)) identity.image = session.user.image;
    // smarty-code#701: the admitted (verified, allowed-domain) email names the person's inbox. The gateway must accept
    // it (installed first) and never copy it into message metadata.
    identity.email = session.user.email;
    const member = forwarded ? members.forwardedMember(session) : null;
    if (member) identity.member = member;
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
        select: ['email', 'emailVerified'] });
      if (!admits(user) || (members.required && !await members.lookup(adapter, session.userId))) return false;
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
    const current = await connections.admit(req, res, session);
    if (!current) return;
    checked();
    req.humanIdentity = actor(current, { forwarded: true });
    return next();
  };
  return {
    auth,
    handler: toNodeHandler(auth),
    resolve,
    protect,
    actor,
    authorizeUiSession,
    sidebarView: createHumanSidebarView({ auth, resolve, actor }),
    status: async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const session = await resolve(req);
      return session ? res.json({ authenticated: true, humanAuth: true, user: actor(session) }) : unauthorized(res);
    },
    dispose: () => connections.dispose(),
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
