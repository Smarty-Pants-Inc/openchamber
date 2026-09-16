import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { isRuntimeRequestScopeCurrent, type RuntimeRequestScope } from '@/lib/runtime-switch';

// Native mobile has no cookie login gate. Its probe ladder owns confirmation;
// the subscription only acknowledges a signal and starts that ladder.
export const subscribeNativeAuthExpiry = (reprobe: () => void) =>
  useAuthSessionStore.subscribe((store, previous) => {
    if (store.state !== 'expired' || previous.state === 'expired') return;
    store.markReauthenticating();
    reprobe();
  });

// Called only after the native ladder confirms the existing transport works.
// A switched transport already renews authority through endpoint reset.
export const completeNativeAuthRecovery = (scope: RuntimeRequestScope) => {
  if (!isRuntimeRequestScopeCurrent(scope)) return false;
  if (useAuthSessionStore.getState().state !== 'ok') {
    useAuthSessionStore.getState().markAuthenticated();
  }
  return true;
};
