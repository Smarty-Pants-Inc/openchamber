import React from 'react';
import { create } from 'zustand';
import { humanAuthClient, useHumanAuth } from './human-auth';

// smarty-code#849: the signed-in person's own account subject (better-auth's user id: the gateway's HumanIdentity
// subject), so a line about who stopped a start can say "you" for the person themself. Read once per page.
export const useHumanSelf = create<{ subject?: string }>(() => ({}));
let loading: Promise<void> | undefined;
export function useHumanSelfSubject(): string | undefined {
  const enabled = useHumanAuth(state => state.enabled);
  const subject = useHumanSelf(state => state.subject);
  React.useEffect(() => {
    if (!enabled || subject || loading) return;
    loading = humanAuthClient().getSession()
      .then(({ data }) => { if (data?.user?.id) useHumanSelf.setState({ subject: data.user.id }); }, () => {})
      .finally(() => { loading = undefined; });
  }, [enabled, subject]);
  return subject;
}
