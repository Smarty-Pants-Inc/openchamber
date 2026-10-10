import React from 'react';
import { opencodeClient } from '@/lib/opencode/client';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import {
  captureRuntimeRequestScope,
  isRuntimeRequestScopeCurrent,
  subscribeRuntimeEndpointChanged,
  type RuntimeRequestScope,
} from '@/lib/runtime-switch';

type Support = { directory: string; sessionID: string; scope: RuntimeRequestScope; available: boolean };

/** Selected-view capability only. Recovery identity belongs to Continue, not to this health read. */
export function useNativeResumeSupport(
  directory: string | undefined,
  sessionID: string | null | undefined,
  enabled: boolean,
): boolean {
  const authState = useAuthSessionStore(state => state.state);
  const recoveryGeneration = useAuthSessionStore(state => state.recoveryGeneration);
  const [endpointGeneration, endpointChanged] = React.useReducer(value => value + 1, 0);
  const [support, setSupport] = React.useState<Support>();
  React.useEffect(() => subscribeRuntimeEndpointChanged(() => endpointChanged()), []);

  React.useEffect(() => {
    if (!enabled || !directory || !sessionID || authState !== 'ok') {
      setSupport(undefined);
      return;
    }
    let disposed = false;
    // Capture before health's first await. Returning to the same URL cannot revive this authority.
    const scope = captureRuntimeRequestScope();
    setSupport(undefined);
    void opencodeClient.supportsNativeResume(directory).then(available => {
      if (!disposed && isRuntimeRequestScopeCurrent(scope)) setSupport({ directory, sessionID, scope, available });
    }).catch(() => {
      // A failed probe never grants support and never removes the Continue owner's recovery record.
      if (!disposed && isRuntimeRequestScopeCurrent(scope)) setSupport({ directory, sessionID, scope, available: false });
    });
    return () => { disposed = true; };
  }, [authState, directory, enabled, endpointGeneration, recoveryGeneration, sessionID]);

  return Boolean(support && enabled && authState === 'ok' && support.directory === directory && support.sessionID === sessionID
    && support.available && isRuntimeRequestScopeCurrent(support.scope));
}
