import { create } from 'zustand';
import { resetRuntimeAuthGeneration } from './runtime-auth';
import { captureRuntimeRequestScope, isRuntimeRequestScopeCurrent, type RuntimeRequestScope } from './runtime-switch';

// Proactive detection of an expired OpenChamber client session (cookie or
// bearer). There is no polling: every HTTP response already funnels through
// runtimeFetch, and this module only classifies what passes by. A 401 alone
// is NOT proof — OpenCode proxies provider errors through the same routes, so
// a dead Anthropic key also surfaces as 401. Every suspicion is therefore
// confirmed with one debounced GET /auth/session before the state flips.
//
// Consumers: the web/hosted banner (AuthExpiredBanner), the send guard in the
// composer, and the native mobile app, which feeds the signal into its own
// connection orchestration instead of showing the shared banner.

export type AuthSessionState = 'ok' | 'expired' | 'reauthenticating';

interface AuthSessionStore {
  state: AuthSessionState;
  recoveryGeneration: number;
  /** Set only by the confirmed classifier or an explicit auth failure. */
  markExpired: () => void;
  markReauthenticating: () => void;
  markAuthenticated: () => void;
}

export const useAuthSessionStore = create<AuthSessionStore>((set) => ({
  state: 'ok',
  recoveryGeneration: 0,
  markExpired: () => set((current) => (current.state === 'expired' ? current : { state: 'expired' })),
  markReauthenticating: () => set({ state: 'reauthenticating' }),
  markAuthenticated: () => {
    // Only verified recovery calls this operation. Publish after retiring old
    // requests so mounted bindings select an SDK from the renewed authority.
    resetRuntimeAuthGeneration();
    set((current) => ({ state: 'ok', recoveryGeneration: current.recoveryGeneration + 1 }));
  },
}));

// One confirm probe per window: parallel 401s from a burst of requests must
// not turn into a probe storm, and a provider-side 401 that keeps repeating
// must not re-probe on every retry.
const CONFIRM_PROBE_MIN_INTERVAL_MS = 15_000;
// Focus revalidation only bothers the server when the tab was away long
// enough for a 12h/7d session to plausibly have died.
const FOCUS_REVALIDATE_MIN_INTERVAL_MS = 5 * 60_000;

let lastProbeAt = -Infinity;
let probeScope: RuntimeRequestScope | null = null;
let probeInFlight: RuntimeRequestScope | null = null;

export const resetRuntimeAuthSession = (): void => {
  probeScope = captureRuntimeRequestScope();
  lastProbeAt = -Infinity;
  probeInFlight = null;
  useAuthSessionStore.setState({ state: 'ok' });
};

const currentProbeScope = (): RuntimeRequestScope => {
  if (!probeScope) probeScope = captureRuntimeRequestScope();
  if (!isRuntimeRequestScopeCurrent(probeScope)) resetRuntimeAuthSession();
  return probeScope ?? captureRuntimeRequestScope();
};

// Paths where a 401 is part of a normal flow (wrong password on login, a
// pairing redeem, the confirm probe itself) rather than evidence of expiry.
const isExcludedAuthPath = (url: string): boolean => (
  url.includes('/auth/session') || url.includes('/api/client-auth/')
);

const isClassifiablePath = (url: string): boolean => {
  const path = url.startsWith('/') ? url : (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return '';
    }
  })();
  if (!path.startsWith('/api/') && !path.startsWith('/auth/')) return false;
  return !isExcludedAuthPath(path);
};

const confirmSessionExpired = async (scope: RuntimeRequestScope): Promise<void> => {
  if (probeInFlight || !isRuntimeRequestScopeCurrent(scope)) return;
  probeInFlight = scope;
  try {
    // Deferred import: runtime-fetch classifies through this module, and the
    // probe deliberately re-enters it (its /auth/session path is excluded).
    const { runtimeFetch } = await import('./runtime-fetch');
    if (!isRuntimeRequestScopeCurrent(scope)) return;
    const response = await runtimeFetch('/auth/session', { credentials: 'include', signal: AbortSignal.timeout(10_000) });
    if (!isRuntimeRequestScopeCurrent(scope)) return;
    if (response.status === 401) {
      useAuthSessionStore.getState().markExpired();
      return;
    }
    if (response.ok) {
      // The suspicious 401 came from deeper in the chain (a provider key, an
      // upstream OpenCode instance) — the OpenChamber session is alive.
      const { state, markAuthenticated } = useAuthSessionStore.getState();
      if (state === 'expired') markAuthenticated();
    }
  } catch {
    // Transport failure is connectivity, not authentication; the connection
    // status machinery owns that story.
  } finally {
    if (probeInFlight === scope) probeInFlight = null;
  }
};

/**
 * Called by runtimeFetch for every response. Cheap by design: everything but
 * a 401 on a classifiable path returns immediately.
 */
export const observeRuntimeAuthResponse = (url: string, status: number, scope = captureRuntimeRequestScope()): void => {
  if (!isRuntimeRequestScopeCurrent(scope)) return;
  currentProbeScope();
  if (status !== 401) return;
  if (useAuthSessionStore.getState().state === 'expired') return;
  if (!isClassifiablePath(url)) return;
  const now = Date.now();
  if (now - lastProbeAt < CONFIRM_PROBE_MIN_INTERVAL_MS) return;
  lastProbeAt = now;
  void confirmSessionExpired(scope);
};

let watchInstalled = false;

/**
 * Revalidates the session when the tab regains visibility after a long
 * absence — the "laptop woke up, everything looks alive, first click fails"
 * case. One request per wake, nothing periodic.
 */
export const installAuthSessionFocusWatch = (): void => {
  // Callers are React effects, so a document always exists here.
  if (watchInstalled) return;
  watchInstalled = true;
  let lastConfirmedAt = Date.now();
  let focusScope = captureRuntimeRequestScope();
  const revalidate = () => {
    if (!isRuntimeRequestScopeCurrent(focusScope)) {
      focusScope = captureRuntimeRequestScope();
      lastConfirmedAt = 0;
    }
    const scope = currentProbeScope();
    if (useAuthSessionStore.getState().state !== 'ok') return;
    const now = Date.now();
    if (now - lastConfirmedAt < FOCUS_REVALIDATE_MIN_INTERVAL_MS) return;
    lastConfirmedAt = now;
    lastProbeAt = now;
    void confirmSessionExpired(scope);
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') revalidate();
  });
  // App switches on desktop can refocus the window without a visibility
  // change; both signals share one throttle, so a wake costs one request.
  window.addEventListener('focus', revalidate);
};
