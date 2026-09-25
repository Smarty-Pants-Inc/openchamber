import { z } from 'zod';
import { getActiveRelayTunnel } from '@/lib/relay/runtime-tunnel';
import { assertRuntimeRequestScope, captureRuntimeRequestScope, isRuntimeRequestScopeCurrent } from './runtime-switch';

type RuntimeAuthCredential =
  | { type: 'bearer'; token: string }
  | null;

export type RuntimeAuthCredentialProvider = () => RuntimeAuthCredential | Promise<RuntimeAuthCredential>;

let credentialProvider: RuntimeAuthCredentialProvider = () => null;
let runtimeBearerToken = '';
let credentialConfigured = false;
let runtimeExtraHeaders: Record<string, string> | null = null;
let runtimeUrlAuthToken = '';
let runtimeUrlAuthTokenExpiresAt = 0;
let runtimeUrlAuthRefreshPromise: Promise<string> | null = null;
let localRuntimeUrlAuthToken = '';
let localRuntimeUrlAuthTokenExpiresAt = 0;
let localRuntimeUrlAuthOrigin = '';
let localRuntimeUrlAuthRefreshPromise: Promise<string> | null = null;
let localRuntimeUrlAuthRefreshOrigin = '';
let localRuntimeUrlAuthGeneration = 0;
let localUrlAuthFailureOrigin = '';
let localUrlAuthFailureCount = 0;
let localUrlAuthRetryAt = 0;
let localUrlAuthRejected = false;
let runtimeAuthGeneration = 0;

export const getRuntimeAuthGeneration = (): number => runtimeAuthGeneration;

const urlAuthResponseSchema = z.object({ token: z.string().trim().min(1), expiresAt: z.number().finite() });

const URL_AUTH_REFRESH_SKEW_MS = 10_000;
const URL_AUTH_REQUEST_TIMEOUT_MS = 10_000;
const URL_AUTH_RETRY_BASE_MS = 1_000;
const URL_AUTH_RETRY_MAX_MS = 30_000;
let urlAuthFailureCount = 0;
let urlAuthRetryAt = 0;
let urlAuthRejected = false;

const isReservedRuntimeExtraHeaderName = (name: string): boolean => name.toLowerCase() === 'authorization';

const sanitizeRuntimeExtraHeaders = (headers: Record<string, string> | null | undefined): Record<string, string> => {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const name = key.trim();
    const headerValue = value.trim();
    if (name && headerValue && !isReservedRuntimeExtraHeaderName(name)) next[name] = headerValue;
  }
  return next;
};

const runtimeExtraHeadersEqual = (left: Record<string, string>, right: Record<string, string>): boolean => {
  const leftEntries = Object.entries(left);
  if (leftEntries.length !== Object.keys(right).length) return false;
  return leftEntries.every(([key, value]) => right[key] === value);
};

const normalizeBearerToken = (token: string | null | undefined): string => {
  if (typeof token !== 'string') return '';
  return token.trim();
};

const readInjectedBearerToken = (): string => {
  if (typeof window === 'undefined') return '';
  const injected = (window as typeof window & { __OPENCHAMBER_CLIENT_TOKEN__?: string }).__OPENCHAMBER_CLIENT_TOKEN__;
  return normalizeBearerToken(injected);
};

const readInjectedApiBaseUrl = (): string => {
  if (typeof window === 'undefined') return '';
  const injected = (window as typeof window & { __OPENCHAMBER_API_BASE_URL__?: string }).__OPENCHAMBER_API_BASE_URL__;
  return typeof injected === 'string' ? injected.trim() : '';
};

const buildAuthUrl = (apiBaseUrl: string | null | undefined, path: string): string => {
  const base = typeof apiBaseUrl === 'string' && apiBaseUrl.trim()
    ? apiBaseUrl.trim()
    : readInjectedApiBaseUrl();
  if (!base) return path;
  try {
    return new URL(path, `${base.replace(/\/+$/, '')}/`).toString();
  } catch {
    return path;
  }
};

const normalizeOrigin = (value: string): string => {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
};

const clearLocalRuntimeUrlAuthToken = (): void => {
  localRuntimeUrlAuthToken = '';
  localRuntimeUrlAuthTokenExpiresAt = 0;
  localRuntimeUrlAuthOrigin = '';
  localRuntimeUrlAuthRefreshPromise = null;
  localRuntimeUrlAuthRefreshOrigin = '';
  localRuntimeUrlAuthGeneration += 1;
  localUrlAuthFailureOrigin = '';
  localUrlAuthFailureCount = 0;
  localUrlAuthRetryAt = 0;
  localUrlAuthRejected = false;
};

export const clearRuntimeUrlAuthToken = (): void => {
  runtimeUrlAuthToken = '';
  runtimeUrlAuthTokenExpiresAt = 0;
  clearLocalRuntimeUrlAuthToken();
};

export const resetRuntimeAuthGeneration = (): void => {
  runtimeAuthGeneration += 1;
  urlAuthFailureCount = 0;
  urlAuthRetryAt = 0;
  urlAuthRejected = false;
  urlAuthApiBaseUrl = null;
  runtimeUrlAuthRefreshPromise = null;
  clearRuntimeUrlAuthToken();
  // Credentials changed: if a consumer is active, re-mint promptly.
  scheduleUrlAuthRefresh();
};

export const setRuntimeAuthCredentialProvider = (provider: RuntimeAuthCredentialProvider): void => {
  credentialConfigured = true;
  runtimeBearerToken = '';
  resetRuntimeAuthGeneration();
  credentialProvider = provider;
};

export const clearRuntimeAuthCredentialProvider = (): void => {
  credentialConfigured = false;
  runtimeBearerToken = '';
  resetRuntimeAuthGeneration();
  credentialProvider = () => null;
};

export const setRuntimeBearerToken = (token: string | null | undefined): void => {
  const normalized = normalizeBearerToken(token);
  credentialConfigured = true;
  runtimeBearerToken = normalized;
  resetRuntimeAuthGeneration();
  credentialProvider = () => normalized ? { type: 'bearer', token: normalized } : null;
};

export const setRuntimeExtraHeaders = (headers: Record<string, string> | null | undefined): void => {
  // These headers are for runtime HTTP fetches and URL-token minting. Browser-owned
  // realtime transports (EventSource/WebSocket) cannot attach arbitrary headers.
  const next = sanitizeRuntimeExtraHeaders(headers);
  if (runtimeExtraHeaders && runtimeExtraHeadersEqual(runtimeExtraHeaders, next)) return;
  runtimeExtraHeaders = next;
  resetRuntimeAuthGeneration();
};

export const getRuntimeExtraHeadersSync = () => {
  if (runtimeExtraHeaders) return { ...runtimeExtraHeaders };
  if (typeof window === 'undefined') return {};
  const injected = (window as typeof window & { __OPENCHAMBER_RUNTIME_HEADERS__?: Record<string, string> }).__OPENCHAMBER_RUNTIME_HEADERS__;
  return injected && typeof injected === 'object' ? sanitizeRuntimeExtraHeaders(injected) : {};
};

export const getRuntimeBearerTokenSync = (): string => credentialConfigured ? runtimeBearerToken : readInjectedBearerToken();

export const setRuntimeUrlAuthToken = (token: string | null | undefined, expiresAt: number | null | undefined): void => {
  const normalized = normalizeBearerToken(token);
  if (!normalized || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    clearRuntimeUrlAuthToken();
    return;
  }
  const previous = runtimeUrlAuthToken;
  runtimeUrlAuthToken = normalized;
  runtimeUrlAuthTokenExpiresAt = expiresAt;
  // Notify only on a real replacement (existing token swapped for a fresh one),
  // not on the initial mint, so consumers remount token-bearing assets only
  // when the URL token actually changed underneath them.
  if (previous && previous !== normalized) {
    notifyRuntimeUrlAuthListeners();
  }
};

export const setLocalRuntimeUrlAuthToken = (
  token: string | null | undefined,
  expiresAt: number | null | undefined,
  localOrigin?: string | null,
): void => {
  const normalized = normalizeBearerToken(token);
  const origin = typeof localOrigin === 'string' ? normalizeOrigin(localOrigin) : '';
  if (!normalized || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || !origin) {
    clearLocalRuntimeUrlAuthToken();
    return;
  }
  localRuntimeUrlAuthToken = normalized;
  localRuntimeUrlAuthTokenExpiresAt = expiresAt;
  localRuntimeUrlAuthOrigin = origin;
};

const readValidRuntimeUrlAuthTokenSync = (): string => {
  if (!runtimeUrlAuthToken || runtimeUrlAuthTokenExpiresAt <= Date.now() + URL_AUTH_REFRESH_SKEW_MS) {
    runtimeUrlAuthToken = '';
    runtimeUrlAuthTokenExpiresAt = 0;
    return '';
  }
  return runtimeUrlAuthToken;
};

const readValidLocalRuntimeUrlAuthTokenSync = (localOrigin: string): string => {
  const origin = normalizeOrigin(localOrigin);
  if (!origin || localRuntimeUrlAuthOrigin !== origin) return '';
  if (!localRuntimeUrlAuthToken || localRuntimeUrlAuthTokenExpiresAt <= Date.now() + URL_AUTH_REFRESH_SKEW_MS) {
    localRuntimeUrlAuthToken = '';
    localRuntimeUrlAuthTokenExpiresAt = 0;
    localRuntimeUrlAuthOrigin = '';
    return '';
  }
  return localRuntimeUrlAuthToken;
};

export const getRuntimeUrlAuthTokenSync = (): string => {
  const token = readValidRuntimeUrlAuthTokenSync();
  if (!token && (getRuntimeBearerTokenSync() || typeof window !== 'undefined')) {
    void refreshRuntimeUrlAuthToken().catch(() => {});
  }
  return token;
};

export const getLocalRuntimeUrlAuthTokenSync = (localOrigin?: string | null): string => {
  const token = localOrigin ? readValidLocalRuntimeUrlAuthTokenSync(localOrigin) : '';
  if (!token && localOrigin && typeof window !== 'undefined') {
    void refreshLocalRuntimeUrlAuthToken(localOrigin).catch(() => {});
  }
  return token;
};

// Use the same deadline through credential preparation, fetch and body IO.
const awaitRuntimeAuth = async <T>(pending: Promise<T>, signal: AbortSignal): Promise<T> => {
  signal.throwIfAborted();
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
};

const getRuntimeAuthCredential = async (signal?: AbortSignal): Promise<RuntimeAuthCredential> => {
  const provider = credentialProvider;
  const fallbackToken = getRuntimeBearerTokenSync();
  const pending = provider();
  const credential = pending instanceof Promise
    ? await awaitRuntimeAuth(pending, signal ?? AbortSignal.timeout(URL_AUTH_REQUEST_TIMEOUT_MS))
    : pending;
  const token = credential?.type === 'bearer'
    ? normalizeBearerToken(credential.token)
    : fallbackToken;
  return token ? { type: 'bearer', token } : null;
};

// Performs the actual network mint and swaps the new token in atomically (the
// previous token stays valid until `setRuntimeUrlAuthToken` replaces it — no
// empty-token window). Concurrent callers share one in-flight request.
const mintRuntimeUrlAuthToken = (apiBaseUrl?: string | null): Promise<string> => {
  if (runtimeUrlAuthRefreshPromise) return runtimeUrlAuthRefreshPromise;
  if (urlAuthRejected || Date.now() < urlAuthRetryAt) {
    return Promise.reject(new Error('Runtime URL auth refresh is waiting for recovery'));
  }
  const scope = captureRuntimeRequestScope();
  const relay = getActiveRelayTunnel();
  const url = apiBaseUrl ? buildAuthUrl(apiBaseUrl, '/auth/url-token') : scope.resolver.auth('/auth/url-token');
  const headers = new Headers(getRuntimeExtraHeadersSync());
  const signal = AbortSignal.timeout(URL_AUTH_REQUEST_TIMEOUT_MS);

  const refreshPromise = (async () => {
    const credential = await getRuntimeAuthCredential(signal);
    assertRuntimeRequestScope(scope);
    if (credential?.type === 'bearer') {
      headers.set('Authorization', `Bearer ${credential.token}`);
    }
    // In relay mode the mint must ride the tunnel, not the network: there is no
    // reachable network base URL. Same auth headers, same route, tunneled.
    const response = await awaitRuntimeAuth(relay
      ? relay.fetch('/auth/url-token', { method: 'POST', headers, signal })
      : fetch(url, { method: 'POST', headers, credentials: 'include', signal }), signal);
    assertRuntimeRequestScope(scope);
    if (!response.ok) {
      // 409: a human-auth (Google sign-in) server never issues URL tokens; the session cookie authorizes instead.
      // Asking again on every backoff tick only added a refused request to each load (smarty-code#126).
      urlAuthRejected = response.status === 401 || response.status === 403 || response.status === 409;
      clearRuntimeUrlAuthToken();
      throw new Error(`Failed to mint runtime URL auth token (${response.status})`);
    }
    const { token, expiresAt } = urlAuthResponseSchema.parse(await awaitRuntimeAuth(response.json(), signal));
    assertRuntimeRequestScope(scope);
    if (expiresAt <= Date.now() + URL_AUTH_REFRESH_SKEW_MS + URL_AUTH_PROACTIVE_BUFFER_MS) {
      throw new Error('Runtime URL auth token response was invalid');
    }
    setRuntimeUrlAuthToken(token, expiresAt);
    urlAuthFailureCount = 0;
    urlAuthRetryAt = 0;
    return runtimeUrlAuthToken;
  })().catch((error) => {
    if (isRuntimeRequestScopeCurrent(scope)) {
      urlAuthFailureCount += 1;
      urlAuthRetryAt = Date.now() + Math.min(URL_AUTH_RETRY_MAX_MS, URL_AUTH_RETRY_BASE_MS * 2 ** Math.min(urlAuthFailureCount - 1, 5));
    }
    throw error;
  });
  const trackedPromise = refreshPromise.finally(() => {
    if (runtimeUrlAuthRefreshPromise === trackedPromise) {
      runtimeUrlAuthRefreshPromise = null;
      if (isRuntimeRequestScopeCurrent(scope)) scheduleUrlAuthRefresh();
    }
  });
  runtimeUrlAuthRefreshPromise = trackedPromise;

  return runtimeUrlAuthRefreshPromise;
};

const mintLocalRuntimeUrlAuthToken = (localOrigin: string): Promise<string> => {
  const origin = normalizeOrigin(localOrigin);
  if (!origin) return Promise.reject(new Error('Local runtime URL auth origin was invalid'));
  if (localRuntimeUrlAuthRefreshPromise && localRuntimeUrlAuthRefreshOrigin === origin) {
    return localRuntimeUrlAuthRefreshPromise;
  }
  if (localUrlAuthFailureOrigin === origin && (localUrlAuthRejected || Date.now() < localUrlAuthRetryAt)) {
    return Promise.reject(new Error('Local runtime URL auth refresh is waiting for recovery'));
  }
  const generation = localRuntimeUrlAuthGeneration;
  const signal = AbortSignal.timeout(URL_AUTH_REQUEST_TIMEOUT_MS);
  const refreshPromise = (async () => {
    const response = await awaitRuntimeAuth(fetch(buildAuthUrl(origin, '/auth/url-token'), {
      method: 'POST',
      credentials: 'include',
      signal,
    }), signal);
    if (!response.ok) {
      if (generation === localRuntimeUrlAuthGeneration && origin === localRuntimeUrlAuthRefreshOrigin) {
        localUrlAuthRejected = response.status === 401 || response.status === 403 || response.status === 409;
        localRuntimeUrlAuthToken = '';
        localRuntimeUrlAuthTokenExpiresAt = 0;
        localRuntimeUrlAuthOrigin = '';
      }
      throw new Error(`Failed to mint local runtime URL auth token (${response.status})`);
    }
    const { token, expiresAt } = urlAuthResponseSchema.parse(await awaitRuntimeAuth(response.json(), signal));
    if (expiresAt <= Date.now() + URL_AUTH_REFRESH_SKEW_MS) throw new Error('Local runtime URL auth token response was invalid');
    if (generation !== localRuntimeUrlAuthGeneration || origin !== localRuntimeUrlAuthRefreshOrigin) {
      throw new Error('Local runtime URL auth token response is stale');
    }
    localRuntimeUrlAuthToken = token;
    localRuntimeUrlAuthTokenExpiresAt = expiresAt;
    localRuntimeUrlAuthOrigin = origin;
    localUrlAuthFailureCount = 0;
    localUrlAuthRetryAt = 0;
    return token;
  })().catch((error) => {
    if (generation === localRuntimeUrlAuthGeneration && origin === localRuntimeUrlAuthRefreshOrigin) {
      localUrlAuthFailureOrigin = origin;
      localUrlAuthFailureCount += 1;
      localUrlAuthRetryAt = Date.now() + Math.min(URL_AUTH_RETRY_MAX_MS, URL_AUTH_RETRY_BASE_MS * 2 ** Math.min(localUrlAuthFailureCount - 1, 5));
    }
    throw error;
  });
  const trackedPromise = refreshPromise.finally(() => {
    if (localRuntimeUrlAuthRefreshPromise === trackedPromise) {
      localRuntimeUrlAuthRefreshPromise = null;
      localRuntimeUrlAuthRefreshOrigin = '';
    }
  });
  localRuntimeUrlAuthRefreshPromise = trackedPromise;
  localRuntimeUrlAuthRefreshOrigin = origin;
  return localRuntimeUrlAuthRefreshPromise;
};

// Returns a valid token without a network call, minting only when the current
// token is missing or already inside the skew window.
export const refreshRuntimeUrlAuthToken = async (apiBaseUrl?: string | null): Promise<string> => {
  const existing = readValidRuntimeUrlAuthTokenSync();
  if (existing) return existing;
  return mintRuntimeUrlAuthToken(apiBaseUrl);
};

export const refreshLocalRuntimeUrlAuthToken = async (localOrigin: string): Promise<string> => {
  const origin = normalizeOrigin(localOrigin);
  if (!origin) throw new Error('Local runtime URL auth origin was invalid');
  const existing = readValidLocalRuntimeUrlAuthTokenSync(origin);
  if (existing) return existing;
  if (
    (localRuntimeUrlAuthOrigin && localRuntimeUrlAuthOrigin !== origin)
    || (localRuntimeUrlAuthRefreshOrigin && localRuntimeUrlAuthRefreshOrigin !== origin)
    || (localUrlAuthFailureOrigin && localUrlAuthFailureOrigin !== origin)
  ) {
    clearLocalRuntimeUrlAuthToken();
  }
  return mintLocalRuntimeUrlAuthToken(origin);
};

// ── Proactive URL auth token refresh ──────────────────────────────────────
// The url token has a short server TTL. Instead of each consumer minting on its
// own timer (and clearing the shared token, which 401s other consumers during
// the refetch), a single scheduler refreshes it just before the skew window —
// but only while at least one consumer is active, so we never poll
// /auth/url-token in the background when nothing needs the token.
let urlAuthConsumerCount = 0;
let urlAuthRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let urlAuthApiBaseUrl: string | null = null;
const urlAuthListeners = new Set<() => void>();
const URL_AUTH_PROACTIVE_BUFFER_MS = 5_000;

const notifyRuntimeUrlAuthListeners = (): void => {
  for (const listener of urlAuthListeners) {
    try {
      listener();
    } catch {
      // A listener throwing must not break the refresh loop.
    }
  }
};

const clearUrlAuthRefreshTimer = (): void => {
  if (urlAuthRefreshTimer !== null) {
    clearTimeout(urlAuthRefreshTimer);
    urlAuthRefreshTimer = null;
  }
};

const scheduleUrlAuthRefresh = (): void => {
  clearUrlAuthRefreshTimer();
  if (urlAuthConsumerCount <= 0 || globalThis.window === undefined || urlAuthRejected) return;

  // Refresh before the skew window so the old token is still valid when the new
  // one swaps in. With no token yet (expiry 0), refresh immediately.
  const refreshAt = runtimeUrlAuthTokenExpiresAt - URL_AUTH_REFRESH_SKEW_MS - URL_AUTH_PROACTIVE_BUFFER_MS;
  const delay = Math.max(0, urlAuthRetryAt - Date.now(), runtimeUrlAuthTokenExpiresAt > 0 ? refreshAt - Date.now() : 0);
  const scope = captureRuntimeRequestScope();

  urlAuthRefreshTimer = setTimeout(() => {
    urlAuthRefreshTimer = null;
    if (urlAuthConsumerCount <= 0 || !isRuntimeRequestScopeCurrent(scope)) return;
    void mintRuntimeUrlAuthToken(urlAuthApiBaseUrl).catch(() => {});
  }, delay);
};

// Register an active url-token consumer. While any consumer is held, the token
// is proactively refreshed before it expires. Returns a release function;
// the proactive loop stops once the last consumer releases.
export const acquireRuntimeUrlAuthToken = (apiBaseUrl?: string | null): (() => void) => {
  if (typeof apiBaseUrl === 'string' && apiBaseUrl.trim()) {
    urlAuthApiBaseUrl = apiBaseUrl.trim();
  }
  urlAuthConsumerCount += 1;
  scheduleUrlAuthRefresh();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    urlAuthConsumerCount = Math.max(0, urlAuthConsumerCount - 1);
    if (urlAuthConsumerCount === 0) {
      clearUrlAuthRefreshTimer();
    }
  };
};

// Subscribe to url-token *replacements* (an existing token swapped for a fresh
// one). Fires only on a real change — not the initial mint — so consumers can
// remount token-bearing assets without churning on first load. Returns an
// unsubscribe function.
export const subscribeRuntimeUrlAuthToken = (listener: () => void): (() => void) => {
  urlAuthListeners.add(listener);
  return () => {
    urlAuthListeners.delete(listener);
  };
};

export const buildRuntimeAuthHeaders = async (headers?: HeadersInit): Promise<Headers> => {
  const generation = runtimeAuthGeneration;
  const next = new Headers(headers);
  for (const [key, value] of Object.entries(getRuntimeExtraHeadersSync())) {
    if (!next.has(key)) next.set(key, value);
  }
  if (next.has('Authorization')) {
    return next;
  }

  const credential = await getRuntimeAuthCredential();
  if (generation !== runtimeAuthGeneration) throw new Error('Runtime auth request is stale');
  if (credential?.type === 'bearer') {
    next.set('Authorization', `Bearer ${credential.token}`);
  }
  return next;
};
