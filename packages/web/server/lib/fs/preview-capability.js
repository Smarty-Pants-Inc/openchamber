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

const isInside = (directory, target) => {
  const inside = path.relative(directory, target);
  return Boolean(inside) && inside !== '..' && !inside.startsWith(`..${path.sep}`) && !path.isAbsolute(inside);
};

// Whether the open file lies inside the granted directory. Linux names the open file itself; elsewhere the resolved
// path must still be the same file (no link), which leaves a narrow folder-swap window.
// ponytail: the deployed Code runs on Linux; a platform without /proc keeps that window until it needs this preview.
const openedInside = async (handle, directory, target, opened) => {
  try {
    return isInside(directory, await fsPromises.readlink(`/proc/self/fd/${handle.fd}`));
  } catch {
    const named = await fsPromises.lstat(target).catch(() => null);
    return Boolean(named) && !named.isSymbolicLink() && named.dev === opened.dev && named.ino === opened.ino;
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
      // Resolve, check containment, then open that resolved path without following a final link (O_NOFOLLOW) and
      // without blocking on a FIFO. Then confirm what was ACTUALLY opened: on Linux the kernel names the open file
      // (/proc/self/fd), so a link or folder swapped in after the check cannot redirect the read outside.
      const target = await fsPromises.realpath(candidate);
      if (!isInside(directory, target)) return notFound();
      handle = await fsPromises.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > MAX_SERVE_BYTES) return notFound();
      if (!(await openedInside(handle, directory, target, opened))) return notFound();
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
