import { isIP } from 'node:net';

// smarty-code#391: in the passwordless mode (no human auth, no UI password), any page in the same browser, a sandboxed
// preview among them, could reach the application's mutations and WebSockets. One rule, for HTTP mutations and for
// every WebSocket upgrade:
// - a request no browser sent (no Origin, no Sec-Fetch-Site: a CLI, a native bridge) passes;
// - a native client's origin passes: the ones the server's CORS policy admits (server/index.js), and a VS Code webview;
// - otherwise it must be same-origin (Sec-Fetch-Site, or an Origin with the request's own host) AND the request's host
//   must be the application's: a loopback name, an IP address, or a configured host. A hostname an attacker rebinds to
//   this listener is same-origin to the browser, so same-origin alone proves nothing about who owns the host.
// Opaque ('null') and other origins are refused.

/** The CORS policy's client origins (server/index.js: packagedClientOrigins and isLocalDevClientOrigin). */
const PACKAGED = new Set(['openchamber-ui://app', 'capacitor://localhost', 'http://localhost', 'https://localhost']);
export const nativeClientOrigin = (origin) => PACKAGED.has(origin) || origin.startsWith('vscode-webview://')
  || /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);

const hostName = (authority) => {
  const value = String(authority).trim().toLowerCase();
  if (value.startsWith('[')) return value.slice(1, value.indexOf(']'));
  return value.split(':')[0];
};

let configuredHosts = async () => [];
/** The application's other hosts (settings' public origin, the active tunnel, OPENCHAMBER_ALLOWED_HOSTS). */
export const configureApplicationHosts = (read) => { configuredHosts = read; };

const header = (req, name) => {
  const value = req.headers?.[name];
  return typeof (Array.isArray(value) ? value[0] : value) === 'string' ? String(Array.isArray(value) ? value[0] : value).trim() : undefined;
};

/** True when this request may act: see the rule above. */
export async function browserRequestAllowed(req) {
  const origin = header(req, 'origin'), site = header(req, 'sec-fetch-site');
  if (origin === undefined && site === undefined) return true;
  if (origin && origin !== 'null' && nativeClientOrigin(origin)) return true;
  const host = (header(req, 'x-forwarded-host')?.split(',')[0] || header(req, 'host') || '').trim().toLowerCase();
  if (!host) return false;
  const name = hostName(host);
  const own = name === 'localhost' || name.endsWith('.localhost') || isIP(name) !== 0
    || (await configuredHosts().catch(() => [])).some((configured) => hostName(configured) === name);
  if (!own) return false;
  if (site === 'same-origin') return true;
  if (!origin || origin === 'null') return false;
  try { return new URL(origin).host.toLowerCase() === host; } catch { return false; }
}
