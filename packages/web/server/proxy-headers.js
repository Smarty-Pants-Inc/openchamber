export const exposedProxyResponseHeaders = 'x-next-cursor, x-smarty-code-catalog';

const filteredRequestHeaders = new Set([
  // Client credentials for the OpenChamber server (UI client tokens) must
  // never reach the managed OpenCode upstream — it only accepts its own auth,
  // so a forwarded client bearer turns every upstream response into a 401.
  'authorization',
  'x-smarty-human-identity',
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
  'accept-encoding',
]);

const filteredResponseHeaders = new Set([
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
  'www-authenticate',
  'content-encoding',
]);

export const collectForwardProxyHeaders = (requestHeaders, authHeaders = {}, humanIdentity = null) => {
  const headers = {};

  for (const [key, value] of Object.entries(requestHeaders || {})) {
    if (!value) continue;
    const normalizedKey = key.toLowerCase();
    if (filteredRequestHeaders.has(normalizedKey)) continue;
    if (normalizedKey === 'cookie') {
      if (humanIdentity) continue;
      const cookie = (Array.isArray(value) ? value.join('; ') : String(value)).split(';')
        .filter(part => !/^(?:__Secure-|__Host-)?better-auth\./.test(part.trim())).join(';').trim();
      if (cookie) headers.cookie = cookie;
      continue;
    }
    headers[normalizedKey] = Array.isArray(value) ? value.join(', ') : String(value);
  }

  if (authHeaders.Authorization) {
    headers.Authorization = authHeaders.Authorization;
    // Only the authenticated server actor may cross the private gateway boundary.
    if (humanIdentity) {
      headers['x-smarty-human-identity'] = Buffer.from(JSON.stringify(humanIdentity)).toString('base64url');
    }
  } else if (humanIdentity) {
    throw new Error('Human identity forwarding requires upstream authentication');
  }

  return headers;
};

export const shouldForwardProxyResponseHeader = (key) => {
  if (typeof key !== 'string' || key.trim().length === 0) {
    return false;
  }

  return !filteredResponseHeaders.has(key.toLowerCase());
};

export const applyForwardProxyResponseHeaders = (responseHeaders, response) => {
  if (!responseHeaders || typeof response?.setHeader !== 'function') {
    return;
  }

  for (const [key, value] of responseHeaders.entries()) {
    if (!shouldForwardProxyResponseHeader(key)) {
      continue;
    }
    response.setHeader(key, value);
  }
};
