// The web terminal was deleted (openchamber#552). Its namespace stays refused
// here so a retired request never reaches the authenticated upstream proxy,
// the served index or an unowned raw upgrade socket.
const RETIRED_NAMESPACES = [['api', 'terminal']];

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

const isRetiredPathname = (pathname) => {
  const segments = pathSegments(pathname);
  if (segments === UNDECIDABLE) return true;
  return RETIRED_NAMESPACES.some((namespace) => namespace.every((part, index) => segments[index] === part));
};

export const isRetiredRoutePath = (rawUrl) => {
  // Node always supplies the request-target string on req.url.
  if (!rawUrl) return false;
  if (isRetiredPathname(rawUrl.split(/[?#]/, 1)[0])) return true;
  // Upgrade handlers read the WHATWG pathname; refuse whatever that view retires too.
  try {
    return isRetiredPathname(new URL(rawUrl, 'http://localhost').pathname);
  } catch {
    return false;
  }
};

const refuseRetiredRouteRequest = (req, res, next) => {
  if (!isRetiredRoutePath(req.originalUrl ?? req.url)) return next();
  res.status(404).json({ error: 'Not Found' });
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
