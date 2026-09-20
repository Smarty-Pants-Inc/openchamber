import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { getMigrations } from 'better-auth/db/migration';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { createHumanAudience } from './human-audience.js';

/** Better Auth owns accounts and sessions. The caller owns the private database and activation. */
export async function createHumanAuth({ database, baseURL, secret, googleClientId, googleClientSecret, allowedDomains }) {
  const admits = createHumanAudience(allowedDomains);
  const origin = new URL(baseURL);
  if (origin.origin !== baseURL || !['https:', 'http:'].includes(origin.protocol)
    || (origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) {
    throw new Error('Human authentication requires an exact HTTPS origin or loopback test origin');
  }
  if (!database || typeof secret !== 'string' || secret.length < 32 || !googleClientId || !googleClientSecret) {
    throw new Error('Human authentication configuration is incomplete');
  }
  const liveResponses = new Map();
  const closeSession = (id) => {
    for (const response of liveResponses.get(id) || []) response.destroy();
    liveResponses.delete(id);
  };
  const deny = () => { throw new APIError('FORBIDDEN', { message: 'This account is not allowed to use this instance' }); };
  const options = {
    database, baseURL, secret,
    trustedOrigins: [baseURL],
    emailAndPassword: { enabled: false },
    socialProviders: { google: { clientId: googleClientId, clientSecret: googleClientSecret, prompt: 'select_account' } },
    account: { accountLinking: { enabled: false } },
    user: {
      changeEmail: { enabled: false },
      validateUserInfo: async ({ user, source }) => {
        if (source.method !== 'oauth' || source.oauth?.providerId !== 'google' || !admits(user)) {
          return { error: 'account_not_allowed', errorDescription: 'This account is not allowed to use this instance' };
        }
      },
    },
    session: { cookieCache: { enabled: false } },
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
        } },
        delete: { after: async (session) => { closeSession(session.id); } },
      },
    },
  };
  // Use the library's schema, not a second hand-maintained account schema.
  const migration = await getMigrations(options);
  await migration.runMigrations();
  const auth = betterAuth(options);
  const resolve = async (req) => {
    // Device bearer credentials do not become people through an ambient cookie.
    if (req.headers.authorization) return null;
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers), query: { disableCookieCache: true } });
    if (!session || !admits(session.user)) return null;
    return session;
  };
  const actor = (session) => ({
    version: 1, issuer: baseURL, subject: session.user.id,
    name: validName(session.user.name) ? session.user.name : 'User',
    ...(validImage(session.user.image) ? { image: session.user.image } : {}),
  });
  const unauthorized = (res) => res.status(401).json({ authenticated: false, locked: true, humanAuthRequired: true });
  const protect = async (req, res, next) => {
    const session = await resolve(req);
    if (!session) return unauthorized(res);
    const responses = liveResponses.get(session.session.id) || new Set();
    liveResponses.set(session.session.id, responses);
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
      if (!responses.size) liveResponses.delete(session.session.id);
    };
    res.once('close', cleanup);
    res.once('finish', cleanup);
    // Register before rechecking so deletion cannot fall between admission and tracking.
    const current = await resolve(req);
    if (closed || res.destroyed || res.writableEnded || !current || current.session.id !== session.session.id) {
      cleanup(); res.destroy(); return;
    }
    req.humanIdentity = actor(current);
    return next();
  };
  return {
    auth,
    handler: toNodeHandler(auth),
    resolve,
    protect,
    actor,
    status: async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const session = await resolve(req);
      return session ? res.json({ authenticated: true, humanAuth: true, user: actor(session) }) : unauthorized(res);
    },
    dispose: () => { for (const id of liveResponses.keys()) closeSession(id); },
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
