// smarty-code#1407: a Feed reply goes through the chat view's own send path (useSessionUIStore.sendMessage, then
// routeMessage: optimistic row, ordinary Pi view checks, prompt receipt). It targets the org agent session by ID; that
// path resolves the session's directory at send time.
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

export type FeedReply = { sessionId: string; text: string; messageID: string };

/** No model is known for this session (no earlier prompt, no configured default): nothing was sent. */
export class FeedSendUnavailableError extends Error {
  constructor() { super('No model to send with'); }
}

export async function sendFeedReply({ sessionId, text, messageID }: FeedReply): Promise<void> {
  const session = useSessionUIStore.getState();
  // The session's own last choice, as the composer would restore it; the configured default otherwise.
  const choice = session.getLastUserChoice(sessionId);
  const config = useConfigStore.getState();
  const providerID = choice?.providerID || config.currentProviderId;
  const modelID = choice?.modelID || config.currentModelId;
  if (!providerID || !modelID) throw new FeedSendUnavailableError();
  await session.sendMessage(text, providerID, modelID, choice?.agent, undefined, undefined, undefined, choice?.variant, 'normal', { sessionId, messageID });
}
