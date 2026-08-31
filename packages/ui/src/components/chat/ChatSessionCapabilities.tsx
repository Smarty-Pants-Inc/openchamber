/* eslint-disable react-refresh/only-export-components -- context provider, hooks, and submit authority share one contract. */
import React from 'react';

export type ChatSessionForkCapability = 'checking' | 'supported' | 'unsupported' | 'error';

export type ChatSessionForkTarget = {
    runtimeKey: string;
    directory: string;
    sessionId: string;
};

export const isSameChatSessionForkTarget = (
    left: ChatSessionForkTarget | null | undefined,
    right: ChatSessionForkTarget | null | undefined,
): boolean => Boolean(left && right
    && left.runtimeKey === right.runtimeKey
    && left.directory === right.directory
    && left.sessionId === right.sessionId);

export const resolveSessionForkCapabilityForSubmit = async (
    capability: ChatSessionForkCapability,
    authorityTarget: ChatSessionForkTarget | null,
    target: ChatSessionForkTarget | null,
    refresh: (target: ChatSessionForkTarget) => Promise<ChatSessionForkCapability>,
): Promise<ChatSessionForkCapability> => {
    if (!target) return 'unsupported';
    if (capability === 'supported' && isSameChatSessionForkTarget(authorityTarget, target)) {
        return 'supported';
    }
    return refresh(target);
};

type ChatSessionForkCapabilityContextValue = {
    capability: ChatSessionForkCapability;
    target: ChatSessionForkTarget | null;
    refresh: (target?: ChatSessionForkTarget | null) => Promise<ChatSessionForkCapability>;
};

const ChatSessionForkSupportContext = React.createContext<ChatSessionForkCapabilityContextValue>({
    capability: 'checking',
    target: null,
    refresh: async () => 'error',
});

export const ChatSessionForkSupportProvider: React.FC<{
    capability: ChatSessionForkCapability;
    target: ChatSessionForkTarget | null;
    refresh: (target?: ChatSessionForkTarget | null) => Promise<ChatSessionForkCapability>;
    children: React.ReactNode;
}> = ({ capability, target, refresh, children }) => (
    <ChatSessionForkSupportContext.Provider value={{ capability, target, refresh }}>
        {children}
    </ChatSessionForkSupportContext.Provider>
);

export const useChatSessionForkCapability = (): ChatSessionForkCapabilityContextValue =>
    React.useContext(ChatSessionForkSupportContext);

export const useChatSessionForkSupported = (): boolean =>
    useChatSessionForkCapability().capability === 'supported';
