import React from 'react';
import { loadOrgAgent, type OrgAgent } from '@/lib/orgAgent';
import { ensureGlobalSessionsLoaded, resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { PiVoiceControl } from './PiVoiceControl';

/**
 * smarty-code#1192: the Voice call control for the signed-in person's own org agent, where no session is open (the org
 * feed page). The gateway names the session (GET /me/org-agent); the fleet session list gives its directory; the
 * shared PiVoiceControl does the rest: the gateway's per-session voice status, the disabled chip with its plain reason,
 * and the page-level call (PiVoiceCallBar) that survives navigation. Nothing shows while either answer is unknown, or
 * for a person with no org agent. Self-contained, so any surface (the new Smarty app included) can mount it as is.
 */
export function OrgAgentVoiceCall({ load = loadOrgAgent }: { load?: () => Promise<OrgAgent | null> }): React.ReactNode {
  const [agent, setAgent] = React.useState<OrgAgent | null>(null);
  React.useEffect(() => {
    let current = true;
    // ponytail: a failed read shows nothing, as PiVoiceControl does for a failed health read; reopening the page reads again.
    load().then(found => { if (current) setAgent(found); }, () => undefined);
    return () => { current = false; };
  }, [load]);
  const sessionId = agent?.sessionId;
  const session = useGlobalSessionsStore(state => sessionId ? state.entityById.get(sessionId) : undefined);
  const directory = session ? resolveGlobalSessionDirectory(session) : null;
  // The page can open before the session list has loaded (the feed view does not need it otherwise).
  React.useEffect(() => { if (sessionId && !session) void ensureGlobalSessionsLoaded().catch(() => undefined); }, [sessionId, session]);
  if (!sessionId || !directory) return null;
  return <PiVoiceControl sessionId={sessionId} directory={directory} />;
}
