import React from 'react';
import { projectTurnRecords, rememberShownOrphans } from '../lib/turns/projectTurnRecords';
import type { ChatMessageEntry, TurnProjectionResult, TurnRecord } from '../lib/turns/types';
import { buildProjectionCacheKey, getCachedProjection, setCachedProjection } from '../lib/turns/turnProjectionCache';
import { streamPerfMeasure } from '@/stores/utils/streamDebug';

interface UseTurnRecordsOptions {
    sessionKey?: string;
    showTextJustificationActivity: boolean;
    showTurnChangedFiles: boolean;
    planModeEnabled: boolean;
    showLeadingOrphans?: boolean;
}

export interface TurnRecordsResult {
    projection: TurnProjectionResult;
    staticTurns: TurnProjectionResult['turns'];
    streamingTurn: TurnProjectionResult['turns'][number] | undefined;
}

export const useTurnRecords = (
    messages: ChatMessageEntry[],
    options: UseTurnRecordsOptions,
): TurnRecordsResult => {
    const previousProjectionRef = React.useRef<TurnProjectionResult | null>(null);
    const staticTurnsRef = React.useRef<TurnRecord[]>([]);
    const streamingTurnRef = React.useRef<TurnRecord | undefined>(undefined);
    const previousSessionKeyRef = React.useRef<string | undefined>(options.sessionKey);
    const previousShowTextJustificationActivityRef = React.useRef(options.showTextJustificationActivity);
    const previousShowTurnChangedFilesRef = React.useRef(options.showTurnChangedFiles);
    const previousPlanModeEnabledRef = React.useRef(options.planModeEnabled);
    // smarty-code#583: replies already shown as leading-orphan rows in this session keep being their own rows.
    const shownOrphansRef = React.useRef<Set<string>>(new Set());

    if (
        previousSessionKeyRef.current !== options.sessionKey
        || previousShowTextJustificationActivityRef.current !== options.showTextJustificationActivity
        || previousShowTurnChangedFilesRef.current !== options.showTurnChangedFiles
        || previousPlanModeEnabledRef.current !== options.planModeEnabled
    ) {
        previousSessionKeyRef.current = options.sessionKey;
        previousShowTextJustificationActivityRef.current = options.showTextJustificationActivity;
        previousShowTurnChangedFilesRef.current = options.showTurnChangedFiles;
        previousPlanModeEnabledRef.current = options.planModeEnabled;
        previousProjectionRef.current = null;
        staticTurnsRef.current = [];
        streamingTurnRef.current = undefined;
        shownOrphansRef.current = new Set();
    }

    React.useEffect(() => {
        previousProjectionRef.current = null;
        staticTurnsRef.current = [];
        streamingTurnRef.current = undefined;
    }, [options.sessionKey, options.showTextJustificationActivity, options.showTurnChangedFiles, options.planModeEnabled]);

    const projection = React.useMemo(() => {
        const sessionKey = options.sessionKey ?? '';
        const kept = shownOrphansRef.current;
        const mergeKey = (options.planModeEnabled ? 'merge:plan' : 'merge') + (options.showLeadingOrphans ? ':leading' : '')
            + (kept.size ? `:kept${kept.size}` : '');
        const cacheKey = buildProjectionCacheKey(
            sessionKey,
            messages,
            options.showTextJustificationActivity,
            options.showTurnChangedFiles,
            mergeKey,
        );
        const cached = getCachedProjection(cacheKey);
        if (cached) {
            previousProjectionRef.current = cached;
            // A new hook (a reopen) served from the shared cache still records the replies it shows as their own
            // rows, so a later prepend of their prompts keeps those rows (openchamber#358 review round 2).
            rememberShownOrphans(messages, cached, kept);
            return cached;
        }

        return streamPerfMeasure('ui.turns.projection_ms', () => {
            const nextProjection = projectTurnRecords(messages, {
                previousProjection: previousProjectionRef.current,
                showTextJustificationActivity: options.showTextJustificationActivity,
                showTurnChangedFiles: options.showTurnChangedFiles,
                mergeHiddenUserTurns: { planModeEnabled: options.planModeEnabled },
                showLeadingOrphans: options.showLeadingOrphans,
                ...(kept.size ? { keepUngroupedAssistantIds: new Set(kept) } : {}),
            });
            previousProjectionRef.current = nextProjection;
            rememberShownOrphans(messages, nextProjection, kept);

            setCachedProjection(cacheKey, nextProjection);

            return nextProjection;
        });
    }, [messages, options.showTextJustificationActivity, options.showTurnChangedFiles, options.sessionKey, options.planModeEnabled, options.showLeadingOrphans]);

    const staticTurns = React.useMemo(() => {
        const nextStatic = projection.turns.length <= 1
            ? []
            : projection.turns.slice(0, -1);
        const previousStatic = staticTurnsRef.current;

        if (previousStatic.length === nextStatic.length) {
            let isSame = true;
            for (let index = 0; index < nextStatic.length; index += 1) {
                if (previousStatic[index] !== nextStatic[index]) {
                    isSame = false;
                    break;
                }
            }
            if (isSame) {
                return previousStatic;
            }
        }

        staticTurnsRef.current = nextStatic;
        return nextStatic;
    }, [projection.turns]);

    const streamingTurn = React.useMemo(() => {
        const nextStreamingTurn = projection.turns.length === 0
            ? undefined
            : projection.turns[projection.turns.length - 1];
        if (streamingTurnRef.current === nextStreamingTurn) {
            return streamingTurnRef.current;
        }
        streamingTurnRef.current = nextStreamingTurn;
        return nextStreamingTurn;
    }, [projection.turns]);

    return {
        projection,
        staticTurns,
        streamingTurn,
    };
};
