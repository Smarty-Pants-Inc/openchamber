import { startWebTiming } from './web-timing.js';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { genericOAuth } from 'better-auth/plugins/generic-oauth';
import { decodeJwt } from 'jose';
import { z } from 'zod';
import { getMigrations } from 'better-auth/db/migration';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { createHumanAudience } from './human-audience.js';
import { createHumanSidebarView } from './human-sidebar-view.js';
import { createHumanMemberBinding } from './human-member.js';
import { createHumanConnectionLifetime } from './human-connection.js';
import { normalizeBasePath } from '../base-path.js';
import { createHumanAuthBasePathOptions } from './human-auth-base-path.js';
import { createOrgMembers } from './human-org-member.js';
import { createBrokerProvisioning } from './human-broker-provisioning.js';
import { deleteSessionCookie } from 'better-auth/cookies';
import { googleSubjectSchema } from '../billing-role/node-member.js';

/** Better Auth owns accounts and sessions. The caller owns the private database and activation. */
export async function createHumanAuth({ database, baseURL, secret, googleClientId, googleClientSecret, allowedDomains,
  broker = null, env = process.env }) {
  const admits = createHumanAudience(allowedDomains);
  const members = createHumanMemberBinding(env);
  const orgMembers = createOrgMembers(broker ? env : {});
  const hostedDomain = allowedDomains.length === 1 && typeof allowedDomains[0] === 'string'
    ? allowedDomains[0].toLowerCase() : null;
  if (!hostedDomain) throw new Error('Human authentication requires one exact Google Workspace domain');
  const origin = new URL(baseURL);
  const publicPath = origin.pathname === '/' ? '' : normalizeBasePath(origin.pathname);
  const basePathOptions = createHumanAuthBasePathOptions(origin, publicPath);
  if (!baseURL || origin.username || origin.password || origin.search || origin.hash
    || baseURL !== `${origin.origin}${publicPath}` || !['https:', 'http:'].includes(origin.protocol)
    || (origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) {
    throw new Error('Human authentication requires an exact HTTPS base URL or loopback test URL');
  }
  if (!database || typeof secret !== 'string' || secret.length < 32
    || (broker ? !validBroker(broker) : !googleClientId || !googleClientSecret)) {
    throw new Error('Human authentication configuration is incomplete');
  }
  // Broker sign-in shares one Google registration, so org membership must gate session issuance.
  if (broker && !orgMembers.enabled) throw new Error('Broker sign-in requires the org member list (SMARTY_CODE_ORG_CONFIG)');
  const brokerProfile = (p) => p?.iss === broker.issuer && p.aud === broker.clientId
    && (p.azp === undefined || p.azp === broker.clientId) && p.federated_claims?.connector_id === broker.connector
    && Array.isArray(p.groups) && p.groups.includes(`hd:${hostedDomain}`);
  let connections, provisioning;
  const deny = () => { throw new APIError('FORBIDDEN', { message: 'This account is not allowed to use this instance' }); };
  const options = {
    database, baseURL: `${baseURL}/api/auth`, basePath: '/api/auth', secret,
    trustedOrigins: [origin.origin],
    advanced: { disableOriginCheck: false, disableCSRFCheck: false,
      defaultCookieAttributes: basePathOptions.defaultCookieAttributes },
    plugins: [...(basePathOptions.plugins ?? []), ...(broker ? [refuseClientIdToken, brokerProvider(broker)] : [])],
    emailAndPassword: { enabled: false },
    account: { accountLinking: { enabled: false } },
    user: {
      additionalFields: { sidebarPreferences: { type: 'string', required: false, input: false, returned: false } },
      changeEmail: { enabled: false },
      validateUserInfo: async ({ user, source }) => {
        const profile = source.oauth?.profile;
        if (source.method !== 'oauth' || source.oauth?.providerId !== 'google'
          || !(broker ? brokerProfile(profile) : profile?.hd === hostedDomain) || !admits(user)
          || !(broker ? await provisioning.admit(user, profile.federated_claims.user_id) : await orgMembers.admitsEmail(user.email))) {
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
        create: { before: async (user) => { if (!admits(user) || (broker && !provisioning.admitsUser(user))) deny(); } },
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
          if (!admits(user) || !(broker ? provisioning.admitsUser(user) : await orgMembers.admitsEmail(user?.email))) deny();
          if (broker) provisioning.session(session);
          // Same stamp in both modes: the broker conveys Google's signed hd, so live sessions survive cutover/rollback.
          return { data: { ...session, workspacePolicy: `google-hd:${hostedDomain}` } };
        } },
        delete: { after: async (session) => { connections?.closeSession(session.id); } },
      },
    },
  };
  if (broker) {
    options.hooks = { before: createAuthMiddleware(async ctx => {
      // These routes establish identity from fresh upstream claims or deliberately
      // end it. Every other cookie-authenticated API operation uses current policy.
      if (['/sign-in/social', '/callback/:id', '/sign-out'].includes(ctx.path)) return;
      const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
      if (!token) return;
      const session = await ctx.context.internalAdapter.findSession(token);
      if (!session) return;
      if (admits(session.user) && await orgMembers.admitsEmail(session.user.email)) return;
      await ctx.context.internalAdapter.deleteSession(token);
      deleteSessionCookie(ctx);
      ctx.setHeader('Cache-Control', 'no-store');
      if (ctx.path === '/get-session') return ctx.json(null);
      deny();
    }) };
    options.databaseHooks.account = {
      create: { before: async (account, context) => {
        const runtime = context?.context ?? await auth.$context;
        const user = await runtime.internalAdapter.findUserById(account.userId);
        if (!provisioning.admitsAccount(account) || !provisioning.admitsUser(user)) deny();
      } },
    };
  }
  if (!broker) options.socialProviders = { google: { clientId: googleClientId, clientSecret: googleClientSecret,
    prompt: 'select_account', hd: hostedDomain } };
  // Use the library's schema, not a second hand-maintained account schema.
  const migration = await getMigrations(options);
  await migration.runMigrations();
  if (broker) {
    provisioning = await createBrokerProvisioning(options, orgMembers);
    options.database = provisioning.database;
  }
  const auth = betterAuth(options);
  const { adapter, socialProviders, authCookies } = await auth.$context;
  // genericOAuth skips a provider whose discovery failed; never serve a pod that cannot sign anyone in.
  if (broker) {
    const provider = socialProviders.find(p => p.id === 'google');
    if (!provider || provider.issuer !== broker.issuer || !provider.idToken || !provider.requiresIdTokenNonce) {
      throw new Error('Human authentication broker discovery did not initialize the pinned google provider');
    }
    provider.idToken.algorithms = ['RS256'];
    auth.handler = provisioning.wrap(auth.handler, authCookies.sessionToken.name);
    auth.fetch = auth.handler;
  }
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
      if (!session || !admits(session.user) || !await orgMembers.admitsEmail(session.user.email)
        || !await members.admit(adapter, session)
        || new Date(session.session.expiresAt).getTime() <= Date.now()) return null;
      return session;
    } catch { return null; } // Lookup failure is a refusal, never an admitted or guessed member.
  };
  connections = createHumanConnectionLifetime({ resolve, members, adapter });
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
      if (!admits(user) || !await orgMembers.admitsEmail(user.email)
        || (members.required && !await members.lookup(adapter, session.userId))) return false;
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

/** The broker's upstream connector is pinned IN CODE: only Dex's Google connector is trusted. A misconfigured
 * non-Google connector (another IdP, a local/password connector) must never mint an admitted identity. */
export const BROKER_UPSTREAM_CONNECTOR = 'google';
const brokerSchema = z.object({ issuer: z.string(), clientId: z.string().regex(/^code-[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
  clientSecret: z.string().trim().min(1), connector: z.literal(BROKER_UPSTREAM_CONNECTOR) });
function validBroker(b) {
  const parsed = brokerSchema.safeParse(b);
  if (!parsed.success) return false;
  try {
    const url = new URL(parsed.data.issuer);
    return parsed.data.issuer === url.origin + url.pathname.replace(/\/$/, '') && !url.search && !url.hash && (url.protocol === 'https:'
      || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  } catch { return false; }
}
// A client-supplied ID token would skip state, PKCE and nonce (round 1 case 8a); only the redirect flow signs in.
const refuseClientIdToken = { id: 'smarty-human-auth-no-client-id-token', hooks: { before: [{
  matcher: (ctx) => ['/sign-in/social', '/link-social'].includes(ctx.path) && ctx.body?.idToken !== undefined,
  handler: createAuthMiddleware(async () => { throw new APIError('NOT_FOUND', { message: 'ID token sign-in is disabled' }); }),
}] } };
function brokerProvider({ issuer, clientId, clientSecret, connector }) {
  return genericOAuth({ config: [{ providerId: 'google', clientId, clientSecret,
    discoveryUrl: `${issuer}/.well-known/openid-configuration`, scopes: ['openid', 'email', 'profile', 'groups', 'federated:id'],
    pkce: true, requireIdTokenVerification: true,
    // Better Auth has verified this ID token (signature, iss, aud, exp, nonce) before it calls getUserInfo; never userinfo.
    getUserInfo: async ({ idToken }) => {
      if (!idToken) return null;
      const claims = decodeJwt(idToken);
      return { ...claims, id: claims.sub, emailVerified: claims.email_verified === true, image: undefined };
    },
    // The Google subject, as direct mode stores it: same account row, same Node/registry identity.
    accountSubject: ({ profile }) => profile?.federated_claims?.connector_id === connector
      && googleSubjectSchema.safeParse(profile.federated_claims.user_id).success ? profile.federated_claims.user_id : '',
  }] });
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
