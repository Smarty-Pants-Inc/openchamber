import { createAuthClient } from 'better-auth/client';
import { create } from 'zustand';
import { runtimeFetch } from './runtime-fetch';
import { getRuntimeUrlResolver } from './runtime-url';
import { browserDisplayName } from './messages/displayName';
import { captureRuntimeRequestScope, isRuntimeRequestScopeCurrent } from './runtime-switch';

export const useHumanAuth = create<{ enabled: boolean }>(() => ({ enabled: false }));

export function setHumanAuthEnabled(enabled: boolean) {
  browserDisplayName.setHumanMode(enabled);
  useHumanAuth.setState({ enabled });
}

/** A client belongs to the currently selected runtime, never a cached previous host. */
export function humanAuthClient() {
  const endpoint = new URL(getRuntimeUrlResolver().api('/api/auth'), window.location.origin);
  return createAuthClient({
    baseURL: endpoint.origin,
    basePath: endpoint.pathname,
    fetchOptions: { customFetchImpl: runtimeFetch, credentials: 'include' },
  });
}

/** smarty-code#2290: the web server sends a signed-out visit of the home-screen app here as `?return=/api/app/...`. The
 * same rule as its safeAppReturn (packages/web/server/lib/ui-auth/human-auth.js): a same-origin path under /api/app/, no
 * `//`, backslash, scheme, control character, `..`/`.` segment, query or percent-escape. Anything else: no return. */
export function appReturn(search: string = window.location.search): string | null {
  const value = new URLSearchParams(search).get('return');
  if (value === null || value.length > 1024 || !value.startsWith('/api/app/')) return null;
  if ([...value].some(c => c.charCodeAt(0) < 0x20 || (c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f)) || /[\\%?#]/.test(value)
    || value.includes('//') || /\/\.{1,2}(?:\/|$)/.test(value)) return null;
  try { return new URL(value, 'https://origin.invalid').pathname === value ? value : null; } catch { return null; }
}

export async function signInWithGoogle() {
  const scope = captureRuntimeRequestScope();
  const back = appReturn(); // #2290: back to the app the person opened, else this page as before.
  const result = await humanAuthClient().signIn.social({
    provider: 'google', callbackURL: back ? new URL(back, window.location.origin).href : window.location.href, disableRedirect: true,
  });
  if (!isRuntimeRequestScopeCurrent(scope)) return;
  if (result.error) throw new Error(result.error.message);
  const destination = new URL(result.data?.url || '');
  if (destination.origin !== 'https://accounts.google.com' || destination.username || destination.password) {
    throw new Error('Invalid Google sign-in destination');
  }
  window.location.assign(destination.href);
}
