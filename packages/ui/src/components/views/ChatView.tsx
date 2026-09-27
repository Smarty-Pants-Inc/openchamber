import React from 'react';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { ChatErrorBoundary } from '@/components/chat/ChatErrorBoundary';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionMessageLoadState, useSyncDirectory } from '@/sync/sync-context';
import { useViewOnlyWatch, viewOnlyWatchVisible } from '@/sync/view-only-watch';

type ChatViewProps = {
    active?: boolean;
    /**
     * Controls message-history subscription independently of `active`.
     * Embedded session-chat panels keep this true so history stays visible
     * while composer focus / background work remain gated by visibility.
     */
    messagesEnabled?: boolean;
    /** A full-screen surface covers this chat (a phone's Settings): it holds no View only watch meanwhile. */
    covered?: boolean;
    readOnly?: boolean;
    initialAllowPromptingSubagentSessions?: boolean;
};

export const ChatView: React.FC<ChatViewProps> = ({
    active = true,
    messagesEnabled,
    covered,
    readOnly = false,
    initialAllowPromptingSubagentSessions,
}) => {
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
    const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
    const syncDirectory = useSyncDirectory();
    const directory = currentSessionDirectory ?? syncDirectory;
    const loadState = useSessionMessageLoadState(currentSessionId ?? '', directory);
    // A View only session's live tail is held on the gateway only while this view shows it (smarty-code#455): hidden
    // (a background tab, another panel) or covered full-screen, none.
    useViewOnlyWatch(currentSessionId, directory, loadState.readOnly === true,
        viewOnlyWatchVisible({ active, messagesEnabled: messagesEnabled ?? active, covered: covered === true }));

    return (
        <ChatErrorBoundary sessionId={currentSessionId || undefined}>
            <ChatContainer
                active={active}
                messagesEnabled={messagesEnabled}
                readOnly={readOnly}
                initialAllowPromptingSubagentSessions={initialAllowPromptingSubagentSessions}
            />
        </ChatErrorBoundary>
    );
};
