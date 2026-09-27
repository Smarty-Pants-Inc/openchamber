import type { ChatMessageEntry, TurnRecord } from './types';

export type RenderEntry =
    | {
        kind: 'ungrouped';
        key: string;
        message: ChatMessageEntry;
        previousMessage?: ChatMessageEntry;
        nextMessage?: ChatMessageEntry;
    }
    | { kind: 'turn'; key: string; turn: TurnRecord; isLastTurn: boolean; nextEntryFirstMessage?: ChatMessageEntry };

/** Static rows in message order: each turn at its user message, each ungrouped message on its own. */
export const buildStaticRenderEntries = (
    staticTurns: TurnRecord[],
    lastTurnId: string | null | undefined,
    messages: ChatMessageEntry[],
    ungroupedIds: Set<string>,
): RenderEntry[] => {
    const turnEntries = staticTurns.map((turn) => ({
        kind: 'turn' as const,
        key: `turn:${turn.turnId}`,
        turn,
        isLastTurn: turn.turnId === lastTurnId,
    }));
    if (ungroupedIds.size === 0) return turnEntries;

    const turnEntryByUserMessageId = new Map<string, RenderEntry>();
    turnEntries.forEach((entry) => turnEntryByUserMessageId.set(entry.turn.userMessage.info.id, entry));
    const orderedEntries: RenderEntry[] = [];
    messages.forEach((message, index) => {
        const turnEntry = turnEntryByUserMessageId.get(message.info.id);
        if (turnEntry) {
            orderedEntries.push(turnEntry);
            return;
        }
        if (!ungroupedIds.has(message.info.id)) return;
        orderedEntries.push({
            kind: 'ungrouped',
            key: `msg:${message.info.id}`,
            message,
            previousMessage: index > 0 ? messages[index - 1] : undefined,
            nextMessage: index < messages.length - 1 ? messages[index + 1] : undefined,
        });
    });
    return orderedEntries;
};

/** The last message as its own live row when it is ungrouped (it may still be streaming). */
export const buildTrailingUngroupedEntry = (messages: ChatMessageEntry[], ungroupedIds: Set<string>): RenderEntry | undefined => {
    if (ungroupedIds.size === 0) return undefined;
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || !ungroupedIds.has(lastMessage.info.id)) return undefined;
    return {
        kind: 'ungrouped',
        key: `msg:${lastMessage.info.id}`,
        message: lastMessage,
        previousMessage: messages.length > 1 ? messages[messages.length - 2] : undefined,
        nextMessage: undefined,
    };
};

/**
 * History rows plus the trailing live row. The trailing row replaces its static copy, so each message renders in
 * exactly one row with a unique list key (an all-assistant first page put its last reply in both, #163 review).
 */
export const assembleRenderEntries = (
    history: RenderEntry[],
    trailing: RenderEntry | undefined,
    messages?: ChatMessageEntry[],
): RenderEntry[] => {
    if (!trailing) return history;
    const rest = history.filter((entry) => entry.key !== trailing.key);
    // Rows after the live turn's user message in the journal (a voice call's turns, smarty-code#538) stay after
    // it, so every row keeps journal order and does not move when the next prompt makes this turn static.
    if (trailing.kind !== 'turn' || !messages || !rest.some((entry) => entry.kind === 'ungrouped')) return [...rest, trailing];
    const order = new Map(messages.map((message, index) => [message.info.id, index]));
    const at = order.get(trailing.turn.userMessage.info.id) ?? Number.POSITIVE_INFINITY;
    const split = rest.findIndex((entry) => entry.kind === 'ungrouped' && (order.get(entry.message.info.id) ?? -1) > at);
    return split < 0 ? [...rest, trailing] : [...rest.slice(0, split), trailing, ...rest.slice(split)];
};
