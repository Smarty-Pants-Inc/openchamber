import React from 'react';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { ChatErrorBoundary } from '@/components/chat/ChatErrorBoundary';
import { useSessionUIStore } from '@/sync/session-ui-store';

type ChatViewProps = {
    active?: boolean;
    /**
     * Controls message-history subscription independently of `active`.
     * Embedded session-chat panels keep this true so history stays visible
     * while composer focus / background work remain gated by visibility.
     */
    messagesEnabled?: boolean;
    /** A full-screen surface covers this chat (ChatContainer's `covered`). */
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

    return (
        <ChatErrorBoundary sessionId={currentSessionId || undefined}>
            <ChatContainer
                active={active}
                messagesEnabled={messagesEnabled}
                covered={covered}
                readOnly={readOnly}
                initialAllowPromptingSubagentSessions={initialAllowPromptingSubagentSessions}
            />
        </ChatErrorBoundary>
    );
};
