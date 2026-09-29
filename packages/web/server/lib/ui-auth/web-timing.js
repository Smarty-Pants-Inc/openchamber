/**
 * smarty-code#827: a fresh profile's steer reached Code's gateway ~4 s after the press while the page sent it in 0.2 s.
 * The web server stamps its own share on the request it forwards: when it received it, and how long its person check
 * (getSession, cookie cache off, twice per request) took. Numbers only; a browser's own values are never forwarded.
 */
export const WEB_TIMING_HEADERS = ['x-smarty-web-received', 'x-smarty-web-auth'];

/** Called as the person check starts; returns the function that records its end and puts this server's stamps on the
 * request's own headers (the proxy forwards the request's headers as they are), replacing any the browser sent. */
export function startWebTiming(req, now = Date.now) {
  const started = now();
  if (req.smartyWebReceived === undefined) req.smartyWebReceived = started;
  return () => {
    req.smartyWebAuthMs = now() - started;
    if (!req.headers) return;
    for (const key of WEB_TIMING_HEADERS) delete req.headers[key];
    Object.assign(req.headers, webTimingHeaders(req));
  };
}

/** The headers to forward: only this server's own stamps, only when they are numbers. */
export function webTimingHeaders(req) {
  const headers = {};
  if (Number.isSafeInteger(req.smartyWebReceived)) headers['x-smarty-web-received'] = String(req.smartyWebReceived);
  if (Number.isSafeInteger(req.smartyWebAuthMs) && req.smartyWebAuthMs >= 0) headers['x-smarty-web-auth'] = String(req.smartyWebAuthMs);
  return headers;
}
