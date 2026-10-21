import { APIError, createAuthMiddleware } from 'better-auth/api';

const REDIRECT_FIELDS = ['callbackURL', 'redirectTo', 'errorCallbackURL', 'newUserCallbackURL'];
const INVALID_REDIRECT_PATH = /%(?:2f|5c)/i;
const REDIRECT_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

export function createHumanAuthBasePathOptions(origin, publicPath) {
  return {
    defaultCookieAttributes: { path: publicPath || '/' },
    ...(publicPath ? { plugins: [createPublicPathRedirectGuard(origin, publicPath)] } : {}),
  };
}

function createPublicPathRedirectGuard(origin, publicPath) {
  return {
    id: 'smarty-human-auth-public-path-redirects',
    hooks: { before: [{
      matcher: ({ body, query }) => [body, query].some((source) =>
        source && typeof source === 'object' && REDIRECT_FIELDS.some((field) => Object.hasOwn(source, field))),
      handler: createAuthMiddleware(async ({ body, query }) => {
        for (const source of [body, query]) {
          if (!source || typeof source !== 'object') continue;
          for (const field of REDIRECT_FIELDS) {
            if (!Object.hasOwn(source, field)) continue;
            const values = Array.isArray(source[field]) ? source[field] : [source[field]];
            if (!values.every((value) => isPublicPathRedirect(value, origin, publicPath))) {
              throw new APIError('FORBIDDEN', { message: 'Human auth redirects must stay under the configured public base path' });
            }
          }
        }
      }),
    }] },
  };
}

function isPublicPathRedirect(value, origin, publicPath) {
  if (typeof value !== 'string' || REDIRECT_CONTROL.test(value) || value.includes('\\')) return false;
  const rawPath = value.split(/[?#]/, 1)[0];
  if (INVALID_REDIRECT_PATH.test(rawPath)) return false;
  try {
    const target = new URL(value, origin.origin + publicPath + '/');
    return target.origin === origin.origin && !target.username && !target.password
      && (target.pathname === publicPath || target.pathname.startsWith(publicPath + '/'));
  } catch { return false; }
}
