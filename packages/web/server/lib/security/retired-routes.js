// Deleted host capabilities stay refused here so a retired request never reaches
// the authenticated upstream proxy, the served index or an unowned raw upgrade
// socket. One classifier and one first upgrade listener own every namespace.
//
// Each namespace is a segment prefix ('*' matches any one segment). `methods`
// lists the retired HTTP methods when the same path still serves other methods
// (for example the read-only GET /api/git/branches); without it every method is
// retired. Upgrades ignore `methods`: no retired namespace owns a socket.
const ALL_METHODS = null;
const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
const RETIRED_NAMESPACES = [
  // openchamber#552: the web terminal.
  { segments: ['api', 'terminal'], methods: ALL_METHODS },
  // smarty-code#1398 slice 2: host-power routes.
  // Shell execution and its job polling.
  { segments: ['api', 'fs', 'exec'], methods: ALL_METHODS },
  // HTTP shutdown (the env-gated dev-shutdown is a different segment).
  { segments: ['api', 'system', 'shutdown'], methods: ALL_METHODS },
  // Update check and install.
  { segments: ['api', 'openchamber', 'update-check'], methods: ALL_METHODS },
  { segments: ['api', 'openchamber', 'update-install'], methods: ALL_METHODS },
  // Tunnel control, the relay host and the dev-server byte pipe.
  { segments: ['api', 'openchamber', 'tunnel'], methods: ALL_METHODS },
  { segments: ['api', 'openchamber', 'relay'], methods: ALL_METHODS },
  { segments: ['api', 'dev-tunnel'], methods: ALL_METHODS },
  // Git writes. Read routes the Git view uses stay served by lib/git/routes.js.
  ...[
    'set-identity', 'discover-credentials', 'integrate', 'revert', 'stage', 'unstage', 'apply-hunk',
    'pull', 'push', 'stash', 'fetch', 'rebase', 'merge', 'commit', 'checkout', 'checkout-commit',
    'cherry-pick', 'revert-commit', 'reset-to-commit', 'remote-branches',
  ].map((name) => ({ segments: ['api', 'git', name], methods: ALL_METHODS })),
  { segments: ['api', 'git', 'identities'], methods: WRITE_METHODS },
  { segments: ['api', 'git', 'branches'], methods: WRITE_METHODS },
  { segments: ['api', 'git', 'remotes'], methods: WRITE_METHODS },
  // Provider keys.
  { segments: ['api', 'quota', 'credentials'], methods: ALL_METHODS },
  { segments: ['api', 'provider', '*', 'auth'], methods: ALL_METHODS },
  // The engine's credential API: the SDK's auth.set (PUT) and auth.remove (DELETE) send
  // /auth/{providerID} under the /api base. Better Auth's sign-in and session routes share
  // /api/auth but use only GET and POST, so only the credential write methods are retired.
  { segments: ['api', 'auth', '*'], methods: ['PUT', 'PATCH', 'DELETE'] },
];

// Tolerant, repeated percent-decoding (security round 2): a malformed escape never stops decoding the
// valid ones, and a value that keeps changing past the bound is treated as retired (fail closed).
const DECODE_ROUNDS = 16;
const UNDECIDABLE = Symbol('undecidable');
const decodeFully = (value) => {
  let current = value;
  for (let round = 0; round < DECODE_ROUNDS; round += 1) {
    const next = current.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    if (next === current) return current;
    current = next;
  }
  return UNDECIDABLE;
};

// Normalize the spellings Express or an upstream may treat as equal: case,
// percent-encoding, backslashes, repeated slashes and dot segments.
const pathSegments = (pathname) => {
  const decoded = decodeFully(pathname);
  if (decoded === UNDECIDABLE) return UNDECIDABLE;
  const segments = [];
  for (const segment of decoded.replace(/\\/g, '/').toLowerCase().split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments;
};

// A method-scoped namespace retires a bare OPTIONS (no Access-Control-Request-Method)
// too: nothing it still serves needs one, so the ambiguous case fails closed.
const retiresMethod = (namespace, method) => namespace.methods === ALL_METHODS
  || !method || namespace.methods.includes(method);

const isRetiredPathname = (pathname, method) => {
  const segments = pathSegments(pathname);
  if (segments === UNDECIDABLE) return true;
  return RETIRED_NAMESPACES.some((namespace) => retiresMethod(namespace, method)
    && namespace.segments.every((part, index) => index < segments.length && (part === '*' || segments[index] === part)));
};

/**
 * True when the request target falls in a retired namespace. `method` is the
 * HTTP method to check; omit it for an upgrade, where every namespace refuses.
 */
export const isRetiredRoutePath = (rawUrl, method) => {
  // Node always supplies the request-target string on req.url.
  if (!rawUrl) return false;
  const normalizedMethod = method?.toUpperCase();
  if (isRetiredPathname(rawUrl.split(/[?#]/, 1)[0], normalizedMethod)) return true;
  // Upgrade handlers read the WHATWG pathname; refuse whatever that view retires too.
  try {
    return isRetiredPathname(new URL(rawUrl, 'http://localhost').pathname, normalizedMethod);
  } catch {
    return false;
  }
};

// The method a request would exercise: a CORS preflight names it in
// Access-Control-Request-Method; a bare OPTIONS names none.
const requestedMethod = (req) => {
  if (req.method !== 'OPTIONS') return req.method;
  // Node supplies this single-value request header as a string when present.
  return req.headers['access-control-request-method']?.trim() ?? '';
};

/** True when an HTTP request (including a CORS preflight) targets a retired route. */
export const isRetiredRouteRequest = (req) => isRetiredRoutePath(req.originalUrl ?? req.url, requestedMethod(req));

/** Sends the local refusal every retired HTTP route gets. */
export const sendRetiredRouteRefusal = (res) => {
  res.status(404).json({ error: 'Not Found' });
};

const refuseRetiredRouteRequest = (req, res, next) => {
  if (!isRetiredRouteRequest(req)) return next();
  sendRetiredRouteRefusal(res);
};

const RETIRED_UPGRADE_RESPONSE = 'HTTP/1.1 404 Not Found\r\n'
  + 'Connection: close\r\n'
  + 'Content-Type: text/plain; charset=utf-8\r\n'
  + 'Content-Length: 9\r\n\r\n'
  + 'Not Found';

// Named so tests can prove it is the first upgrade listener.
const refuseRetiredRouteUpgrade = (req, socket) => {
  if (!isRetiredRoutePath(req.url) || socket.destroyed) return;
  socket.on('error', () => {});
  try {
    socket.write(RETIRED_UPGRADE_RESPONSE);
  } finally {
    socket.destroy();
  }
};

// HTTP: install after authentication and before the generic upstream proxy and
// static fallbacks. Upgrades: prepend, so the refusal runs before every other
// upgrade listener and before any authentication on the raw socket.
export const installRetiredRouteRefusal = ({ app, server }) => {
  app.use(refuseRetiredRouteRequest);
  server.prependListener('upgrade', refuseRetiredRouteUpgrade);
};
