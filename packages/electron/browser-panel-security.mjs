const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export const shouldAllowBrowserPanelCertificateError = ({ url, error }) => {
  if (error !== 'net::ERR_CERT_AUTHORITY_INVALID') return false;

  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
};

// Every spelling that reaches this machine: localhost names, 127.0.0.0/8, 0.0.0.0/8
// (Linux and macOS route 0.0.0.0 to the local host), ::1, :: and IPv4-mapped forms.
// WHATWG URL parsing has already canonicalized decimal, hex and short IPv4 forms.
const isLoopbackHostname = (rawHostname) => {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (/^(127|0)\.\d+\.\d+\.\d+$/.test(hostname)) return true;
  if (hostname === '::1' || hostname === '::') return true;
  // ::ffff:127.x.y.z is canonicalized to ::ffff:7fxx:xxxx; ::ffff:0.x.y.z to ::ffff:0:x or ::ffff:xx:xxxx.
  const mapped = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(hostname);
  if (mapped) {
    const high = parseInt(mapped[1], 16) >> 8;
    return high === 0x7f || high === 0;
  }
  return false;
};

/**
 * True when `url` addresses this machine: a loopback host or a local file.
 * An unparsable URL counts as local (fail closed).
 */
export const isLoopbackUrl = (url) => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'file:') return true;
    if (!parsed.hostname) return false;
    return isLoopbackHostname(parsed.hostname);
  } catch {
    return true;
  }
};

/**
 * Whether a browser-panel request must be cancelled.
 *
 * A window showing a remote OpenChamber host lets that host drive its browser
 * panel (open, snapshot, click, capture). If the panel could load this
 * machine's loopback, the remote host would read pages served only to this
 * client. So a panel whose window is not the local app never reaches loopback;
 * `embedderIsLocal` must be true only when the window is proven local.
 */
export const shouldBlockBrowserPanelRequest = ({ url, embedderIsLocal }) => (
  embedderIsLocal !== true && isLoopbackUrl(url)
);
