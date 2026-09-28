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

/** smarty-code#583: the records at positions [start, end) not loaded yet, drawn at their estimated height. */
export type GapEntry = { kind: 'gap'; key: string; start: number; end: number; heightPx: number };
/** A row of the list: a message row, or a gap of the whole session not loaded yet. */
export type TimelineEntry = RenderEntry | GapEntry;

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

/** The first message a row shows (its user message, or the message itself); none for a gap. */
export const firstMessageIdOf = (entry: TimelineEntry): string | undefined =>
    entry.kind === 'turn' ? entry.turn.userMessage.info.id : entry.kind === 'ungrouped' ? entry.message.info.id : undefined;

/**
 * smarty-code#583: the list sized to the whole session. Each unloaded range of positions becomes one gap row placed
 * where its records belong: before the first row whose first message sits at or after the gap's end. Gaps after the
 * last loaded row (records appended but not loaded) are left out: the live tail arrives by events.
 */
/** Records per gap row (smarty-code#583). */
export const GAP_CHUNK = 100;

export const insertGaps = (
    entries: RenderEntry[],
    gaps: readonly { start: number; end: number; key: string }[],
    positionOf: (messageId: string) => number | undefined,
    recordPx: number,
): TimelineEntry[] => {
    if (gaps.length === 0) return entries;
    const out: TimelineEntry[] = [];
    let next = 0;
    for (const entry of entries) {
        const id = firstMessageIdOf(entry);
        const position = id === undefined ? undefined : positionOf(id);
        while (position !== undefined && next < gaps.length && gaps[next]!.end <= position) {
            const gap = gaps[next++]!;
            // One row per GAP_CHUNK records: a virtual list handles many ordinary rows well, and a single row millions
            // of pixels tall left the list blank (21,795 records, dev-lead's journal on the candidate).
            for (let start = gap.start; start < gap.end; start += GAP_CHUNK) {
                const end = Math.min(gap.end, start + GAP_CHUNK);
                out.push({ kind: 'gap', key: `gap:${start}`, start, end, heightPx: Math.max(1, Math.round((end - start) * recordPx)) });
            }
        }
        out.push(entry);
    }
    return out;
};
