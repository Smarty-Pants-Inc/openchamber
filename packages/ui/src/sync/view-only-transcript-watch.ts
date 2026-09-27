import { useSessionUIStore } from './session-ui-store';
import { useSessionMessageLoadState, useSyncDirectory } from './sync-context';
import { useViewOnlyWatch } from './view-only-watch';

/**
 * Holds the View only watch of the session a transcript shows (smarty-code#455), for every renderer of the shared
 * transcript (ChatContainer): the main ChatView, the agent manager's group detail and the Mini Chat window
 * (openchamber#278 review 12). `shown`: the transcript is on screen now (viewOnlyWatchVisible for ChatView). Two
 * renderers of one session share one watch.
 */
export function useShownViewOnlyWatch(shown: boolean): void {
  const sessionId = useSessionUIStore((state) => state.currentSessionId);
  const sessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  const syncDirectory = useSyncDirectory();
  const directory = sessionDirectory ?? syncDirectory;
  const loadState = useSessionMessageLoadState(sessionId ?? '', directory);
  useViewOnlyWatch(sessionId, directory, loadState.readOnly === true, shown);
}
