import { opencodeClient } from '@/lib/opencode/client';
import { getImperativeSessionMessageLoader } from './session-message-loader';

/**
 * "Continue in a new Pi" on a Code-created session whose Pi ended (smarty-code#365): the gateway starts one new Pi on
 * the session's own transcript, in its own project, and answers that start's state. Ready: the view reloads its
 * history, no longer read-only. Not ready yet: false; the row turns live once the Pi takes input. One click, one
 * request: nothing is retried automatically.
 */
export async function continueEndedSession(directory: string, sessionID: string): Promise<boolean> {
  const start = await opencodeClient.resumeNativeSession(directory, sessionID);
  if (start.phase !== 'ready') return false;
  await getImperativeSessionMessageLoader()?.ensure({ directory, sessionID }, { reason: 'navigation', force: true });
  return true;
}
