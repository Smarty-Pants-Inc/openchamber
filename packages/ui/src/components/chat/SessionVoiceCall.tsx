import React from 'react';
import { readOrdinaryModel } from '@/lib/opencode/ordinaryModel';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSession } from '@/sync/sync-context';
import { PiVoiceControl } from './PiVoiceControl';

/**
 * The Voice call control for a session's composer where the model controls are not on screen (the mobile footer keeps
 * them in a hidden bottom-sheet host). Only an ordinary Pi session can take a call, as in ModelControls (smarty-code#126).
 */
export function SessionVoiceCall({ sessionId, directory }: { sessionId: string; directory?: string }) {
  const stored = useSessionUIStore(state => state.getDirectoryForSession(sessionId));
  const session = useSession(sessionId, stored ?? directory);
  const ordinary = React.useMemo(() => readOrdinaryModel(session), [session]);
  if (!session || ordinary === undefined) return null;
  return <PiVoiceControl sessionId={sessionId} directory={session.directory} />;
}
