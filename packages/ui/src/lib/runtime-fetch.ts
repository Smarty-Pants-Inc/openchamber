import { TUNNEL_PARSE_BASE } from './relay/tunnel-payloads';
import { buildRuntimeAuthHeaders } from './runtime-auth';
import { observeRuntimeAuthResponse } from './runtime-auth-expiry';
import { noteRuntimeAnswered } from './runtime-reachability';
import { getRuntimeUrlResolver, type RuntimeUrlQuery } from './runtime-url';
import { assertRuntimeRequestScope, captureRuntimeRequestScope, isRuntimeRequestScopeCurrent, type RuntimeRequestScope } from './runtime-switch';

export interface RuntimeFetchOptions extends RequestInit {
  query?: RuntimeUrlQuery;
}

const shouldResolveApiPath = (input: string): boolean => {
  return input.startsWith('/api/') || input === '/api' || input.startsWith('/auth/') || input === '/auth' || input === '/health';
};

const getCurrentOrigin = (): string => {
  if (typeof window === 'undefined') return '';
  return window.location.origin || '';
};

const isCurrentWindowUrl = (url: URL): boolean => {
  if (typeof window === 'undefined') return false;
  const currentOrigin = getCurrentOrigin();
  if (currentOrigin && url.origin === currentOrigin) return true;
  try {
    const current = new URL(window.location.href || currentOrigin);
    return url.protocol === current.protocol && url.host === current.host;
  } catch {
    return false;
  }
};

const isAbsoluteUrl = (value: string): boolean => /^[a-z][a-z\d+.-]*:\/\//i.test(value);

const isNgrokHost = (hostname: string): boolean =>
  /(^|\.)ngrok(?:-free)?\.(?:app|dev|io)$/i.test(hostname);

export const addRuntimeProxyHeaders = (url: string, headers: Headers): Headers => {
  try {
    if (isNgrokHost(new URL(url).hostname) && !headers.has('ngrok-skip-browser-warning')) {
      headers.set('ngrok-skip-browser-warning', 'openchamber');
    }
  } catch {
    // Relative and non-HTTP runtime paths do not need proxy-specific headers.
  }
  return headers;
};

const appendRuntimeQuery = (url: URL, query?: RuntimeUrlQuery): void => {
  if (!query) return;
  const entries = query instanceof URLSearchParams ? Array.from(query.entries()) : Object.entries(query);
  for (const [key, value] of entries) {
    if (value === null || value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
};

const isActiveRuntimeServiceUrl = (url: URL): boolean => {
  try {
    const apiBase = getRuntimeUrlResolver().api('/api');
    const base = new URL(apiBase, getCurrentOrigin() || undefined);
    if (url.origin !== base.origin) return false;
    return shouldResolveApiPath(url.pathname);
  } catch {
    return false;
  }
};

const buildRuntimeFetchUrlFromAbsolute = (input: string, query?: RuntimeUrlQuery): string => {
  try {
    const url = new URL(input);
    if (!isCurrentWindowUrl(url)) return input;
    const rewritten = buildRuntimeFetchUrl(`${url.pathname}${url.search}`, query);
    if (!isAbsoluteUrl(rewritten) && (url.protocol === 'http:' || url.protocol === 'https:')) {
      appendRuntimeQuery(url, query);
      return url.toString();
    }
    return url.hash ? `${rewritten}${url.hash}` : rewritten;
  } catch {
    return input;
  }
};

export const buildRuntimeFetchUrl = (input: string, query?: RuntimeUrlQuery): string => {
  if (input === '/health') return getRuntimeUrlResolver().health(query);
  if (input.startsWith('/auth/') || input === '/auth') return getRuntimeUrlResolver().auth(input, query);
  if (shouldResolveApiPath(input)) return getRuntimeUrlResolver().api(input, query);
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(input)) return buildRuntimeFetchUrlFromAbsolute(input, query);
  return input;
};

const shouldAttachRuntimeAuth = (input: string | URL | Request): boolean => {
  const raw = input instanceof Request ? input.url : input.toString();
  if (!isAbsoluteUrl(raw)) {
    return shouldResolveApiPath(raw);
  }

  try {
    return isActiveRuntimeServiceUrl(new URL(raw));
  } catch {
    return false;
  }
};

// Headers API only accepts ISO-8859-1 (Latin-1) characters. Any value containing
// characters outside \u0000-\u00FF causes "Failed to construct/set 'Headers':
// String contains non ISO-8859-1 code point." Encode those values so they round-trip
// safely through the browser's Headers API. Directory hints get an explicit marker
// only when encoded, so plain ASCII paths remain compatible with routes that read
// the header directly.
export const isLatin1Safe = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0xFF) return false;
  }
  return true;
};

const shouldEncodeHeaderValue = (_key: string, value: string): boolean => !isLatin1Safe(value);

export const sanitizeHeadersForBrowser = (init?: HeadersInit): [string, string][] | undefined => {
  if (!init) return undefined;
  // Normalize any HeadersInit shape into a plain array of entries so we can
  // safely inspect and re-encode non-Latin-1 values.
  const sourceEntries: [string, string][] = init instanceof Headers
    ? Array.from(init.entries())
    : Array.isArray(init)
      ? init
      : Object.entries(init);
  if (sourceEntries.length === 0) return undefined;
  const entries: [string, string][] = [];
  let dirty = false;
  let encodedDirectoryHint = false;
  for (const [key, value] of sourceEntries) {
    if (shouldEncodeHeaderValue(key, value)) {
      entries.push([key, encodeURIComponent(value)]);
      dirty = true;
      if (key.toLowerCase() === 'x-opencode-directory') encodedDirectoryHint = true;
    } else {
      entries.push([key, value]);
    }
  }
  if (encodedDirectoryHint) {
    entries.push(['x-opencode-directory-encoding', 'uri']);
  }
  return dirty ? entries : undefined;
};

const mergeHeaders = async (inputHeaders?: HeadersInit, initHeaders?: HeadersInit): Promise<Headers> => {
  const headers = new Headers(sanitizeHeadersForBrowser(inputHeaders) ?? inputHeaders);
  if (initHeaders) {
    new Headers(sanitizeHeadersForBrowser(initHeaders) ?? initHeaders).forEach((value, key) => headers.set(key, value));
  }
  return buildRuntimeAuthHeaders(headers);
};

// ── Relay-mode routing ─────────────────────────────────────────────────────
// When the active runtime is a private relay, runtime HTTP does not go to the
// network: it rides the E2EE tunnel. We route exactly the same paths we would
// resolve for a network runtime (/api, /auth, /health) and attach identical
// auth headers; the bearer/url-token semantics are unchanged, only the
// transport differs. Non-runtime requests (external URLs) fall through to the
// real network fetch.
const appendPathQuery = (path: string, query?: RuntimeUrlQuery): string => {
  if (!query) return path;
  const url = new URL(path, TUNNEL_PARSE_BASE);
  appendRuntimeQuery(url, query);
  return `${url.pathname}${url.search}`;
};

const extractRelayPath = (input: string | URL | Request, query?: RuntimeUrlQuery): string | null => {
  const raw = input instanceof Request ? input.url : input.toString();
  if (!isAbsoluteUrl(raw)) {
    if (!shouldResolveApiPath(raw)) return null;
    return appendPathQuery(raw, query);
  }
  try {
    const url = new URL(raw);
    if (!isCurrentWindowUrl(url) || !shouldResolveApiPath(url.pathname)) return null;
    appendRuntimeQuery(url, query);
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
};

const resolveRuntimeFetchInput = (input: string | URL | Request, query?: RuntimeUrlQuery): string | URL | Request => {
  if (typeof input === 'string') {
    return buildRuntimeFetchUrl(input, query);
  }

  if (input instanceof URL) {
    return buildRuntimeFetchUrl(input.toString(), query);
  }

  const target = buildRuntimeFetchUrl(input.url, query);
  return target === input.url ? input : new Request(target, input);
};

// Response headers can arrive before a switch while the body is still pending.
// Guard the standard buffered readers, including SDK text parsing and clones.
// Streaming consumers retain their own event-pipeline generation checks.
const guardRuntimeReadResponse = (response: Response, scope: RuntimeRequestScope): Response => {
  const guard = <T>(read: () => Promise<T>) => async (): Promise<T> => {
    assertRuntimeRequestScope(scope);
    const value = await read();
    assertRuntimeRequestScope(scope);
    return value;
  };
  response.json = guard(response.json.bind(response));
  response.text = guard(response.text.bind(response));
  response.arrayBuffer = guard(response.arrayBuffer.bind(response));
  response.blob = guard(response.blob.bind(response));
  response.formData = guard(response.formData.bind(response));
  const clone = response.clone.bind(response);
  response.clone = () => guardRuntimeReadResponse(clone(), scope);
  return response;
};

const fetchRuntimeRequest = async (
  input: string | URL | Request,
  init: RuntimeFetchOptions,
  networkFetch: typeof fetch,
): Promise<Response> => {
  const { query, ...requestInit } = init;
  const scope = captureRuntimeRequestScope();
  const relayPath = scope.relay ? extractRelayPath(input, query) : null;
  const relay = relayPath !== null ? scope.relay : null;
  const resolvedInput = relay ? input : resolveRuntimeFetchInput(input, query);
  const url = relayPath ?? (resolvedInput instanceof Request ? resolvedInput.url : resolvedInput.toString());
  const isRuntime = relay !== null || shouldAttachRuntimeAuth(resolvedInput);
  if (!isRuntime) return networkFetch(resolvedInput, requestInit);

  const method = String(requestInit.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const headers = await mergeHeaders(resolvedInput instanceof Request ? resolvedInput.headers : undefined, requestInit.headers);
  assertRuntimeRequestScope(scope);
  addRuntimeProxyHeaders(url, headers);
  // Retain SDK Request bodies, signals and headers. The tunnel consumes stream
  // bodies itself; constructing a relative Request would lose that contract.
  const response = relay
    ? await relay.fetch(input instanceof Request ? input : url, { ...requestInit, headers })
    : await networkFetch(resolvedInput instanceof Request
      ? new Request(resolvedInput, { ...requestInit, headers })
      : resolvedInput, resolvedInput instanceof Request ? undefined : { ...requestInit, headers });

  if (isRuntimeRequestScopeCurrent(scope)) {
    observeRuntimeAuthResponse(url, response.status, scope);
    if (response.ok) noteRuntimeAnswered();
  }
  // Once dispatched, an effect belongs to its origin even after navigation.
  if (method !== 'GET' && method !== 'HEAD') return response;
  if (!isRuntimeRequestScopeCurrent(scope)) {
    void response.body?.cancel().catch(() => {});
    assertRuntimeRequestScope(scope);
  }
  return guardRuntimeReadResponse(response, scope);
};

// No global read sharing: service/loader owners already deduplicate by scope.
// A path-only key cannot distinguish headers, credentials or relay hosts.
let nativeRuntimeFetch: typeof fetch | null = null;
export const runtimeFetch = (input: string | URL | Request, init: RuntimeFetchOptions = {}): Promise<Response> =>
  fetchRuntimeRequest(input, init, nativeRuntimeFetch ?? fetch);

export const installRuntimeFetchBridge = (): void => {
  if (nativeRuntimeFetch || globalThis.window === undefined) return;
  const nativeFetch = window.fetch.bind(window);
  nativeRuntimeFetch = nativeFetch;
  window.fetch = (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> =>
    fetchRuntimeRequest(input, init, nativeFetch);
};
