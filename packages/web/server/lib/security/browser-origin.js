import { isIP } from 'node:net';

// smarty-code#391: in the passwordless mode (no human auth, no UI password), any page in the same browser, a sandboxed
// preview among them, could reach the application's reads, mutations and WebSockets. Two rules:
// 1. applicationAuthority, for EVERY request (reads included): the request's own Host is the application's, a loopback
//    name, an IP address, or a configured host. A hostname an attacker rebinds to this listener is same-origin to the
//    browser; its reads and writes are refused here. Forwarding headers (X-Forwarded-Host and the like) are never used:
//    a page can set them on a same-origin fetch. A proxy in front keeps working when its Host, or the browser's Origin,
//    is a configured host.
// 2. browserRequestAllowed, for mutations and WebSocket upgrades, on top of 1:
//    - a request no browser sent (no Origin, no Sec-Fetch-Site: a CLI, a native bridge) passes;
//    - a native client's origin passes: the ones the server's CORS policy admits (server/index.js), and a VS Code webview;
//    - otherwise the Origin must be this Host's or a configured host's (Sec-Fetch-Site: same-origin alone is not
//      enough). Opaque ('null') and other origins are refused.

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

const configured = async () => (await configuredHosts().catch(() => [])).map(hostName);
const own = async (authority) => {
  const name = hostName(authority);
  return Boolean(name) && (name === 'localhost' || name.endsWith('.localhost') || isIP(name) !== 0 || (await configured()).includes(name));
};
/** Rule 1: the request's own Host is the application's. */
export async function applicationAuthority(req) {
  const host = header(req, 'host');
  return Boolean(host) && own(host);
}
/** Rules 1 and 2: this request may act (a mutation or a WebSocket). */
export async function browserRequestAllowed(req) {
  if (!await applicationAuthority(req)) return false;
  const origin = header(req, 'origin'), site = header(req, 'sec-fetch-site');
  if (origin === undefined && site === undefined) return true;
  if (!origin || origin === 'null') return false;
  if (nativeClientOrigin(origin)) return true;
  let from;
  try { from = new URL(origin); } catch { return false; }
  return from.host.toLowerCase() === header(req, 'host').toLowerCase() || (await configured()).includes(hostName(from.host));
}
