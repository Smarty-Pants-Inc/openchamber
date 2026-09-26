import crypto from 'crypto';
import { constants } from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';

// The Files view's HTML preview (smarty-code#382). An agent-written page must not run as the signed-in user, so it is
// served as a sandboxed document with an opaque origin, and it carries no cookie or URL token. Its own files (CSS,
// scripts, images next to it) load through a capability: a signed, short-lived path that reads only the previewed
// file's directory. That grants nothing beyond what the agent that wrote the page could already read.
// ponytail: a separate artifacts origin would also isolate the page from the app's host name; this keeps one origin.

export const FILE_MIME_MAP = Object.freeze({
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
});

export const MAX_SERVE_BYTES = 100 * 1024 * 1024;

/** A served file becomes a sandboxed document with an opaque origin: its scripts run, but not as the app. */
export const PREVIEW_CSP = 'sandbox allow-scripts';

// ponytail: long enough for an open preview's lazy assets; it reads only what the page's agent could already read.
const PREVIEW_TTL_MS = 8 * 60 * 60 * 1000;
// One key per server process: a restart retires every capability.
const key = crypto.randomBytes(32);
const sign = (payload) => crypto.createHmac('sha256', key).update(payload).digest('base64url');

/** A capability to read files under `directory` (a real, canonical path) until it expires. */
export const mintPreviewCapability = (directory, now = Date.now()) => {
  const payload = Buffer.from(JSON.stringify({ d: directory, e: now + PREVIEW_TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
};

/** The directory a valid, unexpired capability grants, or null. */
export const readPreviewCapability = (capability, now = Date.now()) => {
  if (typeof capability !== 'string') return null;
  const [payload, signature, extra] = capability.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const { d, e } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof d === 'string' && path.isAbsolute(d) && typeof e === 'number' && e > now ? d : null;
  } catch {
    return null;
  }
};

const setPreviewHeaders = (res) => {
  res.setHeader('Content-Security-Policy', PREVIEW_CSP);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // The sandboxed page's module scripts request with Origin: null; the capability, not the origin, is the credential.
  res.setHeader('Access-Control-Allow-Origin', '*');
};

/**
 * GET /api/fs/preview/<capability>/<path under the granted directory>. Registered before any session or origin check:
 * the capability is the only credential, so nothing here reads cookies, tokens or the user's session.
 */
export const registerPreviewServeRoute = (app) => {
  app.get(/^\/api\/fs\/preview\/([^/]+)\/(.+)$/, async (req, res) => {
    const notFound = () => res.status(404).type('text/plain').send('Not found');
    const directory = readPreviewCapability(req.params[0]);
    if (!directory) return notFound();
    const candidate = path.resolve(directory, req.params[1]);
    let handle;
    try {
      // Open first (non-blocking, so a FIFO cannot hold the request), then require that the checked canonical path is
      // the very file that was opened: a link or folder swapped in between cannot redirect the read outside.
      handle = await fsPromises.open(candidate, constants.O_RDONLY | constants.O_NONBLOCK);
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > MAX_SERVE_BYTES) return notFound();
      const target = await fsPromises.realpath(candidate);
      const inside = path.relative(directory, target);
      if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) return notFound();
      const named = await fsPromises.stat(target);
      if (named.dev !== opened.dev || named.ino !== opened.ino) return notFound();
      const content = await handle.readFile();
      setPreviewHeaders(res);
      return res.type(FILE_MIME_MAP[path.extname(target).toLowerCase()] || 'application/octet-stream').send(content);
    } catch {
      return notFound();
    } finally {
      await handle?.close().catch(() => {});
    }
  });
};
