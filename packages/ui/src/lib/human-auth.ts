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

export async function signInWithGoogle() {
  const scope = captureRuntimeRequestScope();
  const result = await humanAuthClient().signIn.social({
    provider: 'google', callbackURL: window.location.href, disableRedirect: true,
  });
  if (!isRuntimeRequestScopeCurrent(scope)) return;
  if (result.error) throw new Error(result.error.message);
  const destination = new URL(result.data?.url || '');
  if (destination.origin !== 'https://accounts.google.com' || destination.username || destination.password) {
    throw new Error('Invalid Google sign-in destination');
  }
  window.location.assign(destination.href);
}
