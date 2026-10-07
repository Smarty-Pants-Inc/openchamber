import { memberExecutionRefused } from './node-member-execution.js';

/**
 * Node members have read-only access until member execution is isolated (smarty-code#1442). In Node mode every
 * signed-in human is a member (ui-auth/human-member.js), so the server mounts this gate first, before every route and
 * router, and it denies by default: a request passes only when its method and canonical path are on the read-only
 * allow-list below. Allowed requests still meet the human auth gate after this one. Outside Node mode it does nothing.
 */
export const MEMBER_READ_ONLY = 'members have read-only access until isolation, smarty-code#1442';

const READS = new Set(['GET', 'HEAD']);
// Relative to /api: session and history views, event streams, fs reads (the fs routes keep them inside the granted
// root) and Git status, diff and log reads (member Git runs isolated; node-member-execution.js).
const API_READS = [
  /^\/session(?:\/[^/]+)*$/, /^\/(?:global\/)?event$/, /^\/notifications\/stream$/, /^\/openchamber\/events$/,
  /^\/session-activity$/, /^\/session-folders$/, /^\/sessions\/(?:attention|snapshot|status)$/,
  /^\/sessions\/[^/]+\/(?:attention|status)$/,
  /^\/fs\/(?:list|read|stat|raw|home)$/,
  /^\/git\/(?:status|diff|file-diff|log|commit-files|commit-file-diff|range-diff|range-files|branches|check|toplevel|primary-root|worktree-type|worktrees|stashes)$/,
];
// The attention marks a viewer sets on a session; they change no agent, file or Git state.
const API_VIEW_MARKS = /^\/sessions\/[^/]+\/(?:view|unview)$/;
// A preview capability URL carries an encoded file path; the route serves only what its capability names.
const PREVIEW = /^\/api\/fs\/preview\/[^/]+\/.+$/;

/** The path lower-cased, as Express routes it (case-insensitive, trailing slash ignored). Null when an upstream router
 *  could read it differently (encoded characters, backslashes, dot segments, repeated slashes): such a path is denied. */
const canonicalPath = (path) => {
  const lower = path.toLowerCase().replace(/(.)\/$/, '$1');
  return /%|\\|\/\/|(?:^|\/)\.\.?(?:\/|$)/.test(lower) ? null : lower;
};

/** Whether a Node member may make this request. `bearer`: the request carries an Authorization header. */
export const memberRequestAllowed = (method, path, { bearer = false } = {}) => {
  if (method === 'OPTIONS') return true;
  if (READS.has(method) && PREVIEW.test(path)) return true;
  const canonical = canonicalPath(path);
  if (canonical === null) return false;
  if (canonical !== '/api' && !canonical.startsWith('/api/')) return READS.has(method); // the UI shell, health, status
  const api = canonical.slice(4);
  if (api === '/auth' || api.startsWith('/auth/')) return true; // sign-in, sign-out and profile (Better Auth)
  if (method === 'POST' && api === '/openchamber/agent-tool') return bearer; // the agent; the route checks its token
  if (READS.has(method)) return API_READS.some(pattern => pattern.test(api));
  return method === 'POST' && API_VIEW_MARKS.test(api);
};

export const memberAllowList = (req, res, next) => {
  if (!memberExecutionRefused(process.env)) return next();
  if (memberRequestAllowed(req.method, req.path, { bearer: Boolean(req.headers.authorization) })) return next();
  return res.status(403).json({ error: MEMBER_READ_ONLY, code: 'NODE_MEMBER_READ_ONLY' });
};
