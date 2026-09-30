import { isHiddenUserMessage } from '../../message/hiddenUserMessage';
import { projectTurnActivity } from './projectTurnActivity';
import { projectTurnIndexes } from './projectTurnIndexes';
import { projectTurnChangedFiles, projectTurnDiffStats, projectTurnSummary } from './projectTurnSummary';
import type {
    ChatMessageEntry,
    TurnMessageRecord,
    TurnProjectionResult,
    TurnRecord,
    TurnStreamState,
} from './types';

const resolveMessageRole = (message: ChatMessageEntry): string => {
    const role = (message.info as { clientRole?: string | null; role?: string | null }).clientRole ?? message.info.role;
    return typeof role === 'string' ? role : '';
};

const getMessageParentId = (message: ChatMessageEntry): string | undefined => {
    const parentId = (message.info as { parentID?: unknown }).parentID;
    if (typeof parentId !== 'string' || parentId.trim().length === 0) {
        return undefined;
    }
    return parentId;
};

const getMessageCreatedAt = (message: ChatMessageEntry): number | undefined => {
    const created = (message.info as { time?: { created?: unknown } }).time?.created;
    return typeof created === 'number' ? created : undefined;
};

const getMessageCompletedAt = (message: ChatMessageEntry): number | undefined => {
    const completed = (message.info as { time?: { completed?: unknown } }).time?.completed;
    return typeof completed === 'number' ? completed : undefined;
};

const getUserSummaryBody = (message: ChatMessageEntry): string | undefined => {
    const summaryBody = (message.info as { summary?: { body?: unknown } | null | undefined })?.summary?.body;
    if (typeof summaryBody !== 'string') {
        return undefined;
    }

    const trimmed = summaryBody.trim();
    return trimmed.length > 0 ? summaryBody : undefined;
};

const createTurnMessageRecord = (message: ChatMessageEntry, order: number): TurnMessageRecord => {
    const role = resolveMessageRole(message);
    return {
        messageId: message.info.id,
        role,
        parentMessageId: getMessageParentId(message),
        message,
        order,
    };
};

const buildTurnStreamState = (userMessage: ChatMessageEntry, assistantMessages: ChatMessageEntry[]): TurnStreamState => {
    const startedAt = getMessageCreatedAt(userMessage);
    let completedAt: number | undefined;
    let isStreaming = false;

    assistantMessages.forEach((message) => {
        const completed = getMessageCompletedAt(message);
        if (typeof completed === 'number') {
            completedAt = Math.max(completedAt ?? 0, completed);
        } else {
            isStreaming = true;
        }
    });

    const durationMs = typeof startedAt === 'number' && typeof completedAt === 'number' && completedAt >= startedAt
        ? completedAt - startedAt
        : undefined;

    return {
        isStreaming,
        isRetrying: assistantMessages.length > 1,
        startedAt,
        completedAt,
        durationMs,
    };
};

interface ProjectTurnRecordsOptions {
    previousProjection?: TurnProjectionResult | null;
    showTextJustificationActivity: boolean;
    showTurnChangedFiles: boolean;
    /**
     * When set, a turn whose user message is hidden (no visible display parts,
     * e.g. synthetic subagent-completion nudges) is merged into the previous
     * turn instead of starting a new one.
     */
    mergeHiddenUserTurns?: { planModeEnabled: boolean };
    /** Older history exists above the loaded window: show the leading assistant messages. */
    showLeadingOrphans?: boolean;
    /**
     * smarty-code#583: replies the list already showed as their own rows (leading orphans, their user message not yet
     * loaded). They stay their own rows when that user message arrives with an older page, so the rows the reader is
     * looking at keep their keys and the list keeps their place; regrouping them into a new turn row moved the view.
     */
    keepUngroupedAssistantIds?: ReadonlySet<string>;
    /**
     * smarty-code#583: the first loaded message of each loaded window after a gap. The replies that open such a window
     * (their user message lies in the gap) show as their own rows, like the leading replies of the first window.
     */
    windowStartIds?: ReadonlySet<string>;
}

const DEFAULT_OPTIONS: ProjectTurnRecordsOptions = {
    previousProjection: null,
    showTextJustificationActivity: false,
    showTurnChangedFiles: false,
    mergeHiddenUserTurns: undefined,
    showLeadingOrphans: false,
};

const areSameMessageRefs = (left: ChatMessageEntry[], right: ChatMessageEntry[]): boolean => {
    if (left === right) {
        return true;
    }
    if (left.length !== right.length) {
        return false;
    }

    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) {
            return false;
        }
    }

    return true;
};

const canReusePreviousTurn = (previous: TurnRecord, next: TurnRecord): boolean => {
    return previous.userMessage === next.userMessage
        && previous.headerMessageId === next.headerMessageId
        && areSameMessageRefs(previous.assistantMessages, next.assistantMessages);
};

const hydrateTurnRecord = (
    turn: TurnRecord,
    effectiveOptions: ProjectTurnRecordsOptions,
): TurnRecord => {
    turn.summary = projectTurnSummary(turn.assistantMessages);
    turn.summaryText = turn.summary.text ?? getUserSummaryBody(turn.userMessage);
    turn.diffStats = projectTurnDiffStats(turn.userMessage);
    turn.changedFiles = effectiveOptions.showTurnChangedFiles
        ? projectTurnChangedFiles(turn.userMessage)
        : undefined;

    const activity = projectTurnActivity({
        turnId: turn.turnId,
        assistantMessages: turn.assistantMessages,
        summarySourceMessageId: turn.summary.sourceMessageId,
        summarySourcePartId: turn.summary.sourcePartId,
        showTextJustificationActivity: effectiveOptions.showTextJustificationActivity,
    });
    turn.activityParts = activity.activityParts;
    turn.activitySegments = activity.activitySegments;
    turn.hasTools = activity.hasTools;
    turn.hasReasoning = activity.hasReasoning;

    turn.stream = buildTurnStreamState(turn.userMessage, turn.assistantMessages);
    turn.startedAt = turn.stream.startedAt;
    turn.completedAt = turn.stream.completedAt;
    turn.durationMs = turn.stream.durationMs;
    return turn;
};

const hydrateStableTurnRecords = (
    turns: TurnRecord[],
    effectiveOptions: ProjectTurnRecordsOptions,
): TurnRecord[] => {
    const previousProjection = effectiveOptions.previousProjection;
    if (!previousProjection || previousProjection.turns.length === 0 || turns.length === 0) {
        return turns.map((turn) => hydrateTurnRecord(turn, effectiveOptions));
    }

    let canReuseTurnArray = previousProjection.turns.length === turns.length;
    let reusedAnyTurn = false;

    const nextTurns = turns.map((turn, index) => {
        const previousTurn = previousProjection.indexes.turnById.get(turn.turnId);
        if (previousTurn && canReusePreviousTurn(previousTurn, turn)) {
            reusedAnyTurn = true;
            if (previousProjection.turns[index] !== previousTurn) {
                canReuseTurnArray = false;
            }
            return previousTurn;
        }

        canReuseTurnArray = false;
        return hydrateTurnRecord(turn, effectiveOptions);
    });

    if (canReuseTurnArray && reusedAnyTurn) {
        return previousProjection.turns;
    }

    return nextTurns;
};

export const projectTurnRecords = (
    messages: ChatMessageEntry[],
    options?: Partial<ProjectTurnRecordsOptions>,
): TurnProjectionResult => {
    const effectiveOptions: ProjectTurnRecordsOptions = {
        ...DEFAULT_OPTIONS,
        ...options,
    };

    const turns: TurnRecord[] = [];
    const turnByUserId = new Map<string, TurnRecord>();
    const groupedMessageIds = new Set<string>();

    const mergeHiddenUserTurns = effectiveOptions.mergeHiddenUserTurns;

    messages.forEach((message, index) => {
        const role = resolveMessageRole(message);
        if (role !== 'user') {
            return;
        }

        const previousTurn = turns[turns.length - 1];
        if (
            mergeHiddenUserTurns
            && previousTurn
            && isHiddenUserMessage(message, { planModeEnabled: mergeHiddenUserTurns.planModeEnabled })
        ) {
            turnByUserId.set(message.info.id, previousTurn);
            previousTurn.messages.push(createTurnMessageRecord(message, index));
            groupedMessageIds.add(message.info.id);
            return;
        }

        const turnId = message.info.id;
        const turn: TurnRecord = {
            turnId,
            userMessageId: message.info.id,
            userMessage: message,
            headerMessageId: undefined,
            messages: [createTurnMessageRecord(message, index)],
            assistantMessageIds: [],
            assistantMessages: [],
            activityParts: [],
            activitySegments: [],
            summary: {},
            summaryText: undefined,
            hasTools: false,
            hasReasoning: false,
            diffStats: undefined,
            changedFiles: undefined,
            stream: {
                isStreaming: false,
                isRetrying: false,
            },
        };
        turns.push(turn);
        turnByUserId.set(turn.userMessageId, turn);
        groupedMessageIds.add(message.info.id);
    });

    // smarty-code#583 (openchamber#363 r13): each loaded window after a gap is its own segment. A reply joins its prompt's
    // turn only within one segment: a prompt loaded in an EARLIER range would otherwise pull the reply back before the
    // gap. Such a reply opens its window as its own row (the orphan pass below).
    const segmentOf = new Map<string, number>();
    if (effectiveOptions.windowStartIds?.size) {
        let segment = 0;
        for (const message of messages) {
            if (effectiveOptions.windowStartIds.has(message.info.id)) segment++;
            segmentOf.set(message.info.id, segment);
        }
    }
    messages.forEach((message, index) => {
        const role = resolveMessageRole(message);
        if (role !== 'assistant') {
            return;
        }

        if (effectiveOptions.keepUngroupedAssistantIds?.has(message.info.id)) {
            return;
        }
        const parentId = getMessageParentId(message);
        const targetTurn = parentId ? turnByUserId.get(parentId) : undefined;
        if (!targetTurn) {
            return;
        }
        if (parentId && segmentOf.size && segmentOf.get(parentId) !== segmentOf.get(message.info.id)) {
            return;
        }

        targetTurn.assistantMessages.push(message);
        targetTurn.assistantMessageIds.push(message.info.id);
        targetTurn.messages.push(createTurnMessageRecord(message, index));
        if (!targetTurn.headerMessageId) {
            targetTurn.headerMessageId = message.info.id;
        }
        groupedMessageIds.add(message.info.id);
    });

    const stableTurns = hydrateStableTurnRecords(turns, effectiveOptions);
    const projection = projectTurnIndexes(stableTurns);
    const ungroupedMessageIds = new Set<string>();
    // When older history exists above the loaded window, assistant messages before its first user message belong to
    // a turn whose user message is not loaded yet. Show them rather than a blank timeline that pages back through
    // megabytes of tool output looking for a user turn (smarty-code#116 pilot). Later orphans stay hidden: those are
    // a reply that arrived before its own user message.
    // Each window after a gap (smarty-code#583) opens the same way: its replies before its first user message show.
    let leading = effectiveOptions.showLeadingOrphans === true;
    messages.forEach((message) => {
        if (effectiveOptions.windowStartIds?.has(message.info.id)) leading = true;
        if (resolveMessageRole(message) === 'assistant') {
            if (effectiveOptions.keepUngroupedAssistantIds?.has(message.info.id)) {
                ungroupedMessageIds.add(message.info.id);
                return;
            }
            if (leading && !groupedMessageIds.has(message.info.id)) {
                ungroupedMessageIds.add(message.info.id);
            }
            return;
        }
        // System notes are standalone rows, not boundaries of the window's leading replies.
        if (resolveMessageRole(message) !== 'system-note') leading = false;
        if (!groupedMessageIds.has(message.info.id)) {
            ungroupedMessageIds.add(message.info.id);
        }
    });

    return {
        ...projection,
        ungroupedMessageIds,
    };
};

/** smarty-code#583: adds the replies this projection shows as their own leading-orphan rows to `kept`. */
export const rememberShownOrphans = (messages: ChatMessageEntry[], projection: TurnProjectionResult, kept: Set<string>): void => {
    for (const message of messages) {
        if (projection.ungroupedMessageIds.has(message.info.id) && resolveMessageRole(message) === 'assistant') {
            kept.add(message.info.id);
        }
    }
};
