import { opencodeClient } from '@/lib/opencode/client';
import { getImperativeSessionMessageLoader } from './session-message-loader';

/**
 * "Continue in a new Pi" on a Code-created session whose Pi ended (smarty-code#365): the gateway starts one new Pi on
 * the session's own transcript and answers once it is enrolled. The view then reloads its history, which is no longer
 * read-only. One click, one request: nothing is retried automatically.
 */
export async function continueEndedSession(directory: string, sessionID: string): Promise<void> {
  await opencodeClient.resumeNativeSession(directory, sessionID);
  await getImperativeSessionMessageLoader()?.ensure({ directory, sessionID }, { reason: 'navigation', force: true });
}
