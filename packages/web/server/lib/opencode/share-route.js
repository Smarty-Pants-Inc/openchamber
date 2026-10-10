// smarty-dev#799: the iPhone "Send to my Smarty" Shortcut posts a transcript to POST /api/me/share. A Shortcut has no UI
// session, so this one route is the trust-boundary exception: it skips UI (and tunnel) session auth and carries no human
// identity, and only it forwards the client's share token to the gateway, which validates the token. Every other /api
// route still needs a session, and the client's Authorization header is never forwarded anywhere.
export const SHARE_TOKEN_HEADER = 'x-smarty-share-token';

/** Exactly `POST /api/me/share`: no trailing slash, no query, no other case or encoding. */
export const isShareRequest = (req) => req?.method === 'POST' && req.originalUrl === '/api/me/share';
