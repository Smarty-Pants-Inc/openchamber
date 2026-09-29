import React from 'react';
import { create } from 'zustand';
import { humanAuthClient, useHumanAuth } from './human-auth';
import { captureRuntimeRequestScope, isRuntimeRequestScopeCurrent, subscribeRuntimeEndpointChanged, type RuntimeRequestScope } from './runtime-switch';

// smarty-code#849: the signed-in person's own account subject (better-auth's user id: the gateway's HumanIdentity
// subject), so a line about who stopped a start can say "you" for the person themself. Read once per runtime: a
// runtime switch clears it (as SessionAuthGate resets), and a read from the previous runtime is dropped.
export const useHumanSelf = create<{ subject?: string; runtime: number }>(() => ({ runtime: 0 }));
let loading: RuntimeRequestScope | undefined;
export function useHumanSelfSubject(): string | undefined {
  const enabled = useHumanAuth(state => state.enabled);
  const subject = useHumanSelf(state => state.subject);
  const runtime = useHumanSelf(state => state.runtime);
  React.useEffect(() => subscribeRuntimeEndpointChanged(() => {
    loading = undefined;
    useHumanSelf.setState(state => ({ subject: undefined, runtime: state.runtime + 1 }));
  }), []);
  React.useEffect(() => {
    if (!enabled || subject || (loading && isRuntimeRequestScopeCurrent(loading))) return;
    const scope = captureRuntimeRequestScope();
    loading = scope;
    humanAuthClient().getSession()
      .then(({ data }) => {
        if (isRuntimeRequestScopeCurrent(scope) && data?.user?.id) useHumanSelf.setState({ subject: data.user.id });
      }, () => {})
      .finally(() => { if (loading === scope) loading = undefined; });
  }, [enabled, subject, runtime]);
  return subject;
}
