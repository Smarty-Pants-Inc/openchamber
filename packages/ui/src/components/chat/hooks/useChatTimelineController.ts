import React from 'react';

import type { ChatMessageEntry } from '../lib/turns/types';
import type { MessageListHandle } from '../MessageList';
import { PREPEND_ANCHOR_HOLD, READER_INTENT_EVENTS } from '../lib/scroll/anchorHold';
import { SCROLL_NAVIGATE_EVENT } from '@/lib/scrollIntent';

// A scroll within this long after the reader's own input is theirs (momentum included), not a programmatic one.
const READER_SCROLL_WINDOW_MS = 1200;
import {
    buildTurnWindowModel,
    updateTurnWindowModelIncremental,
    type TurnWindowModel,
} from '../lib/turns/windowTurns';
import type { TurnHistorySignals } from '../lib/turns/historySignals';
import { getMemoryLimits, type SessionHistoryMeta } from '@/stores/types/sessionTypes';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';

type ViewportAnchor = { messageId: string; offsetTop: number };
type TimelineIdentityToken = { key: string | null };

type PendingScrollRequest = {
    identity: TimelineIdentityToken;
    kind: 'turn' | 'message';
    id: string;
    behavior: ScrollBehavior;
    turnId: string | null;
    resolve: (value: boolean) => void;
};

interface UseChatTimelineControllerOptions {
    sessionId: string | null;
    sessionKey: string | null;
    messages: ChatMessageEntry[];
    historyMeta: SessionHistoryMeta | null;
    scrollRef: React.RefObject<HTMLDivElement | null>;
    /** The live scroll element: the timeline is mounted anew when a session's positions arrive (smarty-code#583), and
     *  the listeners bound to the old element must move to the new one (openchamber#457 review 1). */
    scrollNode?: HTMLElement | null;
    messageListRef: React.RefObject<MessageListHandle | null>;
    loadMoreMessages: (sessionId: string, direction: 'up' | 'down') => Promise<void>;
    goToBottom: (mode?: 'instant' | 'smooth') => void;
    releaseAutoFollow: () => void;
    isPinned: boolean;
    showScrollButton: boolean;
}

export interface UseChatTimelineControllerResult {
    turnIds: string[];
    turnStart: number;
    renderedMessages: ChatMessageEntry[];
    historySignals: TurnHistorySignals;
    isLoadingOlder: boolean;
    pendingRevealWork: boolean;
    activeTurnId: string | null;
    showScrollToBottom: boolean;
    turnWindowModel: TurnWindowModel;
    loadEarlier: (options?: { userInitiated?: boolean }) => Promise<void>;
    revealBufferedTurns: () => Promise<boolean>;
    resumeToBottom: () => void;
    resumeToBottomInstant: () => Promise<void>;
    scrollToTurn: (turnId: string, options?: { behavior?: ScrollBehavior }) => Promise<boolean>;
    scrollToMessage: (messageId: string, options?: { behavior?: ScrollBehavior }) => Promise<boolean>;
    handleHistoryScroll: () => void;
    captureViewportAnchor: () => ViewportAnchor | null;
    restoreViewportAnchor: (anchor: ViewportAnchor) => boolean;
    handleActiveTurnChange: (turnId: string | null) => void;
}

const TURN_MODEL_CACHE_MAX = 30
// Desktop load-older lead distance. Trigger well before the top: the fetch
// then completes and the prepend lands ABOVE the viewport, where key-anchored
// compensation is exact and invisible. A short lead (the old 200px) let the
// user reach the estimated-height region near the absolute top mid-fetch,
// where the post-insert restore is least precise and reads as a small jump.
const HISTORY_SCROLL_THRESHOLD_MIN_PX = 1200
const HISTORY_SCROLL_VIEWPORT_FACTOR = 1.5
const resolveHistoryScrollThreshold = (clientHeight: number): number => Math.max(
    HISTORY_SCROLL_THRESHOLD_MIN_PX,
    clientHeight * HISTORY_SCROLL_VIEWPORT_FACTOR,
)
const VSCODE_TURN_MODEL_CACHE_MAX = 4
const VSCODE_TURN_MODEL_CACHE_MAX_MESSAGES = 30
const MOBILE_TURN_MODEL_CACHE_MAX = 4
const MOBILE_TURN_MODEL_CACHE_MAX_MESSAGES = 30
export const HISTORY_RENDER_WAIT_TIMEOUT_MS = 250
const HISTORY_INTERACTION_GUARD_MS = 2000
// Long smooth scrolls across a big session can take a couple of seconds;
// the pin releases early as soon as the spy reports the target turn.
const SCROLL_PIN_TIMEOUT_MS = 2500
const turnModelCache = new Map<string, { messages: ChatMessageEntry[]; model: TurnWindowModel }>()
const getTurnModelCacheMax = () => {
    if (isVSCodeRuntime()) return VSCODE_TURN_MODEL_CACHE_MAX
    if (isMobileSurfaceRuntime()) return MOBILE_TURN_MODEL_CACHE_MAX
    return TURN_MODEL_CACHE_MAX
}

const shouldCacheTurnModelMessages = (messages: ChatMessageEntry[]): boolean => {
    if (isVSCodeRuntime()) return messages.length <= VSCODE_TURN_MODEL_CACHE_MAX_MESSAGES
    if (isMobileSurfaceRuntime()) return messages.length <= MOBILE_TURN_MODEL_CACHE_MAX_MESSAGES
    return true
}

const rememberTurnModel = (key: string, value: { messages: ChatMessageEntry[]; model: TurnWindowModel }) => {
    turnModelCache.delete(key)
    if (!shouldCacheTurnModelMessages(value.messages)) {
        return
    }
    const max = getTurnModelCacheMax()
    while (turnModelCache.size >= max) {
        const oldest = turnModelCache.keys().next().value
        if (typeof oldest !== 'string') break
        turnModelCache.delete(oldest)
    }
    turnModelCache.set(key, value)
}

export const shouldAutoLoadEarlierForUnderfilledPinnedViewport = (input: {
    sessionId: string | null;
    isPinned: boolean;
    canLoadEarlier: boolean;
    isLoadingOlder: boolean;
    pendingRevealWork: boolean;
    scrollHeight: number;
    clientHeight: number;
}): boolean => {
    if (!input.sessionId) return false;
    if (!input.isPinned || !input.canLoadEarlier) return false;
    if (input.isLoadingOlder || input.pendingRevealWork) return false;
    return input.scrollHeight <= input.clientHeight + 1;
};

export const isOlderHistoryPrependCommit = (input: {
    previousOldestId: string | null;
    previousNewestId: string | null;
    currentOldestId: string | null;
    currentNewestId: string | null;
}): boolean => Boolean(
    input.previousOldestId
    && input.currentOldestId
    && input.currentOldestId !== input.previousOldestId
    && input.previousNewestId
    && input.currentNewestId
    && input.currentNewestId === input.previousNewestId,
);

// iOS WKWebView ignores programmatic scrollTop writes while a touch drag or
// momentum (fling) scroll is active: the native scroll animation keeps running
// and overwrites the value on the next frame. The mobile history threshold is
// large enough that the prepend commit almost always lands mid-fling, so a
// plain `container.scrollTop = target` never sticks. Toggling overflow kills
// the native scroll synchronously (pre-paint, invisible inside a layout
// effect); a short post-paint watchdog re-asserts the target if residual
// momentum still drags the viewport upward.
const MOMENTUM_WATCHDOG_FRAMES = 20;
const MOMENTUM_WATCHDOG_TOLERANCE_PX = 4;

const setScrollTopDefeatingMomentum = (container: HTMLElement, target: number) => {
    const previousOverflow = container.style.overflow;
    container.style.overflow = 'hidden';
    container.scrollTop = target;
    void container.scrollHeight;
    container.style.overflow = previousOverflow;
    container.scrollTop = target;

    if (typeof window === 'undefined') return;
    let cancelled = false;
    let frames = 0;
    const cancelOnUserTouch = () => {
        cancelled = true;
    };
    container.addEventListener('touchstart', cancelOnUserTouch, { passive: true, once: true });
    const watch = () => {
        if (cancelled) return;
        // Only correct upward drift (residual momentum). Downward movement or
        // content growth above the viewport must not be fought here.
        if (container.scrollTop < target - MOMENTUM_WATCHDOG_TOLERANCE_PX) {
            container.scrollTop = target;
        }
        frames += 1;
        if (frames < MOMENTUM_WATCHDOG_FRAMES) {
            window.requestAnimationFrame(watch);
        } else {
            container.removeEventListener('touchstart', cancelOnUserTouch);
        }
    };
    window.requestAnimationFrame(watch);
};

const hasInsertedBeforeKnownOldest = (
    previousOldestId: string | null,
    currentOldestId: string | null,
    messages: ChatMessageEntry[],
): boolean => {
    if (!previousOldestId || !currentOldestId || currentOldestId === previousOldestId) {
        return false;
    }

    return messages.some((message) => message.info.id === previousOldestId);
};

export const useChatTimelineController = ({
    sessionId,
    sessionKey,
    messages,
    historyMeta,
    scrollRef,
    scrollNode,
    messageListRef,
    loadMoreMessages,
    goToBottom,
    releaseAutoFollow,
    isPinned,
    showScrollButton,
}: UseChatTimelineControllerOptions): UseChatTimelineControllerResult => {
    const previousTurnWindowModelRef = React.useRef<TurnWindowModel | null>(null);
    const previousMessagesRef = React.useRef<ChatMessageEntry[] | null>(null);
    const previousTurnWindowKeyRef = React.useRef<string | null>(null);
    const turnWindowModel = React.useMemo(() => {
        const key = sessionKey ?? ""
        if (previousTurnWindowKeyRef.current !== sessionKey) {
            previousTurnWindowKeyRef.current = sessionKey;
            previousTurnWindowModelRef.current = null;
            previousMessagesRef.current = null;
        }
        const cached = key ? turnModelCache.get(key) : undefined
        if (cached && cached.messages === messages) {
            rememberTurnModel(key, cached)
            previousTurnWindowModelRef.current = cached.model
            previousMessagesRef.current = messages
            return cached.model
        }

        const incrementalModel = updateTurnWindowModelIncremental(
            previousTurnWindowModelRef.current,
            previousMessagesRef.current,
            messages,
        );
        const nextModel = incrementalModel ?? buildTurnWindowModel(messages);
        previousTurnWindowModelRef.current = nextModel;
        previousMessagesRef.current = messages;

        if (key && messages.length > 0) {
            rememberTurnModel(key, { messages, model: nextModel })
        }

        return nextModel;
    }, [messages, sessionKey]);

    const [isLoadingOlder, setIsLoadingOlder] = React.useState(false);
    const [pendingRevealWork, setPendingRevealWork] = React.useState(false);
    const [activeTurnId, setActiveTurnId] = React.useState<string | null>(null);

    const turnModelRef = React.useRef(turnWindowModel);
    const isPinnedRef = React.useRef(isPinned);
    const isLoadingOlderRef = React.useRef(isLoadingOlder);
    const pendingRevealWorkRef = React.useRef(pendingRevealWork);
    const sessionIdRef = React.useRef<string | null>(sessionId);
    const timelineIdentityRef = React.useRef<TimelineIdentityToken>({ key: sessionKey });
    if (timelineIdentityRef.current.key !== sessionKey) {
        timelineIdentityRef.current = { key: sessionKey };
    }
    const messagesRef = React.useRef(messages);
    const historyMetaRef = React.useRef<SessionHistoryMeta | null>(historyMeta);
    const initializedSessionKeyRef = React.useRef<string | null>(null);
    const pendingRenderResolversRef = React.useRef<Array<() => void>>([]);
    const pendingScrollRequestRef = React.useRef<PendingScrollRequest | null>(null);
    const scrollPinRef = React.useRef<{ turnId: string; expiresAt: number } | null>(null);
    const historyInteractionRef = React.useRef(false);
    const historyInteractionTimerRef = React.useRef<number | null>(null);
    // smarty-code#583: true only after an older load that ADDED rows; it lets that load chain the next page.
    const recheckAfterLoadRef = React.useRef(false);

    const historySignals = React.useMemo(() => {
        const defaultLimit = getMemoryLimits().HISTORICAL_MESSAGES;
        const hasBufferedTurns = false;
        const hasMoreAboveTurns = historyMeta
            ? !historyMeta.complete
            : messages.length >= defaultLimit;
        const historyLoading = Boolean(historyMeta?.loading);
        return {
            hasBufferedTurns,
            hasMoreAboveTurns,
            historyLoading,
            canLoadEarlier: hasMoreAboveTurns,
        };
    }, [historyMeta, messages.length]);

    const historySignalsRef = React.useRef(historySignals);

    turnModelRef.current = turnWindowModel;
    isPinnedRef.current = isPinned;
    isLoadingOlderRef.current = isLoadingOlder;
    pendingRevealWorkRef.current = pendingRevealWork;
    historySignalsRef.current = historySignals;
    sessionIdRef.current = sessionId;
    messagesRef.current = messages;
    historyMetaRef.current = historyMeta;

    const beginHistoryInteraction = React.useCallback(() => {
        historyInteractionRef.current = true;
        if (historyInteractionTimerRef.current !== null && typeof window !== 'undefined') {
            window.clearTimeout(historyInteractionTimerRef.current);
            historyInteractionTimerRef.current = null;
        }
    }, []);

    const settleHistoryInteraction = React.useCallback(() => {
        if (typeof window === 'undefined') {
            historyInteractionRef.current = false;
            return;
        }

        if (historyInteractionTimerRef.current !== null) {
            window.clearTimeout(historyInteractionTimerRef.current);
        }
        historyInteractionTimerRef.current = window.setTimeout(() => {
            historyInteractionTimerRef.current = null;
            historyInteractionRef.current = false;
        }, HISTORY_INTERACTION_GUARD_MS);
    }, []);

    React.useLayoutEffect(() => {
        if (initializedSessionKeyRef.current === sessionKey) {
            return;
        }
        if (historyInteractionTimerRef.current !== null && typeof window !== 'undefined') {
            window.clearTimeout(historyInteractionTimerRef.current);
            historyInteractionTimerRef.current = null;
        }
        historyInteractionRef.current = false;
        initializedSessionKeyRef.current = sessionKey;
        const pendingScroll = pendingScrollRequestRef.current;
        if (pendingScroll && pendingScroll.identity !== timelineIdentityRef.current) {
            pendingScrollRequestRef.current = null;
            pendingScroll.resolve(false);
        }
        setIsLoadingOlder(false);
        setPendingRevealWork(false);
        scrollPinRef.current = null;
        setActiveTurnId(null);
    }, [sessionKey]);

    React.useLayoutEffect(() => {
        if (!isPinned) {
            return;
        }
        const latestTurnId = turnWindowModel.turnIds[turnWindowModel.turnIds.length - 1];
        if (!latestTurnId) {
            return;
        }
        // A sent prompt updates the timeline model before its new DOM node is
        // measurable by the scroll spy. While pinned, the latest turn is
        // authoritative and keeps the rail in sync for that interval.
        setActiveTurnId((current) => current === latestTurnId ? current : latestTurnId);
    }, [isPinned, turnWindowModel.turnIds]);

    const resolvePendingRenderWaiters = React.useCallback(() => {
        const resolvers = pendingRenderResolversRef.current;
        if (resolvers.length === 0) {
            return;
        }
        pendingRenderResolversRef.current = [];
        resolvers.forEach((resolve) => resolve());
    }, []);

    const waitForNextRenderCommitOrTimeout = React.useCallback((): Promise<void> => {
        return new Promise<void>((resolve) => {
            if (typeof window === 'undefined') {
                resolve();
                return;
            }

            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timer);
                resolve();
            };
            pendingRenderResolversRef.current.push(finish);
            const timer = window.setTimeout(finish, HISTORY_RENDER_WAIT_TIMEOUT_MS);
        });
    }, []);

    const resolvePendingScrollRequest = React.useCallback((value: boolean) => {
        const pending = pendingScrollRequestRef.current;
        if (!pending) {
            return;
        }
        pendingScrollRequestRef.current = null;
        pending.resolve(value);
    }, []);

    const attemptPendingScrollRequest = React.useCallback(() => {
        const pending = pendingScrollRequestRef.current;
        if (!pending) {
            return;
        }

        if (pending.identity !== timelineIdentityRef.current) {
            resolvePendingScrollRequest(false);
            return;
        }

        const didScroll = pending.kind === 'turn'
            ? (messageListRef.current?.scrollToTurnId(pending.id, { behavior: pending.behavior }) ?? false)
            : (messageListRef.current?.scrollToMessageId(pending.id, { behavior: pending.behavior }) ?? false);

        if (didScroll) {
            if (pending.turnId) {
                // Pin the indicator to the target so the scroll spy's
                // intermediate reports during the smooth scroll don't drag
                // it backwards before the animation lands.
                scrollPinRef.current = {
                    turnId: pending.turnId,
                    expiresAt: Date.now() + SCROLL_PIN_TIMEOUT_MS,
                };
                setActiveTurnId(pending.turnId);
            }
            resolvePendingScrollRequest(true);
            return;
        }

        const targetIndex = pending.kind === 'turn'
            ? turnModelRef.current.turnIndexById.get(pending.id)
            : turnModelRef.current.messageToTurnIndex.get(pending.id);

        if (typeof targetIndex === 'number') {
            resolvePendingScrollRequest(false);
        }
    }, [messageListRef, resolvePendingScrollRequest]);

    React.useEffect(() => {
        return () => {
            if (historyInteractionTimerRef.current !== null && typeof window !== 'undefined') {
                window.clearTimeout(historyInteractionTimerRef.current);
                historyInteractionTimerRef.current = null;
            }
            resolvePendingRenderWaiters();
            resolvePendingScrollRequest(false);
        };
    }, [resolvePendingRenderWaiters, resolvePendingScrollRequest]);

    const renderedMessages = messages;

    React.useLayoutEffect(() => {
        resolvePendingRenderWaiters();
        attemptPendingScrollRequest();
    }, [attemptPendingScrollRequest, renderedMessages, resolvePendingRenderWaiters]);

    // --- Synchronous scroll compensation for load-more / reveal ---
    // fetchOlderHistory and revealBufferedTurns store a snapshot here
    // before triggering the state change. useLayoutEffect consumes it
    // after React commits new DOM — before the browser paints.
    const prePrependScrollRef = React.useRef<{
        identity: TimelineIdentityToken;
        height: number;
        top: number;
        anchor: ViewportAnchor | null;
        /** Explicit navigation happened while the page was pending: hold nothing when it lands (smarty-code#583). */
        yielded?: boolean;
        historyVirtualized: boolean;
        oldestId: string | null;
        newestId: string | null;
    } | null>(null);

    const captureViewportAnchor = React.useCallback((): ViewportAnchor | null => {
        return messageListRef.current?.captureViewportAnchor() ?? null;
    }, [messageListRef]);

    const restoreViewportAnchor = React.useCallback((anchor: ViewportAnchor): boolean => {
        return messageListRef.current?.restoreViewportAnchor(anchor) ?? false;
    }, [messageListRef]);

    // Tracks the timeline edges + height of the previous commit so a prepend
    // that did NOT go through fetchOlderHistory (e.g. the background history
    // prepend dispatched from useSync) can be compensated too. With
    // overflow-anchor:none the browser leaves scrollTop unchanged when content
    // is inserted above, so without this the viewport visibly jumps and
    // auto-follow yanks it back on the next frame — a one-shot up/down judder.
    const prependTrackingRef = React.useRef<{
        oldestId: string | null;
        newestId: string | null;
        scrollHeight: number;
    } | null>(null);

    React.useLayoutEffect(() => {
        prePrependScrollRef.current = null;
        prependTrackingRef.current = null;
    }, [sessionKey]);

    React.useLayoutEffect(() => {
        const container = scrollRef.current;
        if (!container) return;

        let snap = prePrependScrollRef.current;
        const prev = prependTrackingRef.current;
        const currentOldestId = renderedMessages[0]?.info?.id ?? null;
        const currentNewestId = renderedMessages[renderedMessages.length - 1]?.info?.id ?? null;
        // A prepend = content inserted ABOVE the viewport: either the newest
        // stayed fixed, or the old first message still exists below a new first
        // message. The latter keeps preservation alive if a tail append lands in
        // the same commit as the history page.
        const isPrepend = prev
            ? isOlderHistoryPrependCommit({
                previousOldestId: prev.oldestId,
                previousNewestId: prev.newestId,
                currentOldestId,
                currentNewestId,
            }) || hasInsertedBeforeKnownOldest(prev.oldestId, currentOldestId, renderedMessages)
            : false;

        if (snap && snap.identity !== timelineIdentityRef.current) {
            prePrependScrollRef.current = null;
            snap = null;
        }

        const isSnapshotPrepend = snap
            ? isOlderHistoryPrependCommit({
                previousOldestId: snap.oldestId,
                previousNewestId: snap.newestId,
                currentOldestId,
                currentNewestId,
            }) || hasInsertedBeforeKnownOldest(snap.oldestId, currentOldestId, renderedMessages)
            : false;
        const didPrepend = isPrepend || isSnapshotPrepend;
        const shouldConsumeSnapshot = Boolean(snap && (isPrepend || isSnapshotPrepend));

        const updateTracking = () => {
            prependTrackingRef.current = {
                oldestId: currentOldestId,
                newestId: currentNewestId,
                scrollHeight: container.scrollHeight,
            };
        };

        const refreshPendingSnapshot = () => {
            const pending = prePrependScrollRef.current;
            if (!pending) {
                return;
            }

            prePrependScrollRef.current = {
                ...pending,
                height: container.scrollHeight,
                top: container.scrollTop,
                anchor: pending.yielded ? null : captureViewportAnchor(),
                oldestId: currentOldestId,
                newestId: currentNewestId,
            };
        };

        if (isPinnedRef.current) {
            // Bottom-pinned. Only content inserted ABOVE (a prepend / history load)
            // needs an explicit re-pin: with overflow-anchor:none the browser leaves
            // scrollTop unchanged, so the viewport would visibly jump. Route that
            // through goToBottom — the single programmatic writer.
            //
            // A normal bottom APPEND (a sent message, a streaming part) must NOT
            // re-pin here. Auto-follow already owns the bottom: its content
            // ResizeObserver re-pins instantly (scrollTop = scrollHeight, before
            // paint) on every append. Re-pinning again from here would just be a
            // second writer chasing the same target a frame later — redundant at
            // best, and the source of the old up/down jiggle on send / from the
            // queue / while streaming. So for an append we do nothing and let
            // auto-follow own it.
            if (didPrepend) {
                prePrependScrollRef.current = null;
                goToBottom('instant');
            } else if (snap) {
                refreshPendingSnapshot();
            }
            updateTracking();
            return;
        }

        // TanStack owns every scroll adjustment for virtualized history. It
        // preserves stable keyed items across prepends and reconciles later row
        // measurements. Restoring the DOM anchor here as well creates a second
        // writer: depending on whether measurement has landed, it can apply the
        // same prepend delta twice or fall back to scrollToIndex against the new
        // indexes, throwing the viewport far downward.
        const historyVirtualized = messageListRef.current?.isHistoryVirtualized() ?? false;

        if (snap && shouldConsumeSnapshot) {
            prePrependScrollRef.current = null;
            if (historyVirtualized) {
                // The newly enabled virtualizer has no prior keyed state for the
                // threshold-crossing commit, so allow one anchor restore. Once
                // already virtualized, TanStack is the sole scroll owner.
                if (!snap.historyVirtualized && snap.anchor) {
                    restoreViewportAnchor(snap.anchor);
                } else if (snap.anchor) {
                    // smarty-code#583: the list keeps a prepend's place by row key, but an older page often changes
                    // the reader's own row: replies regroup into the turn whose user message just loaded (the key
                    // is gone), or that turn row changes height above the reader. Either moved the view by up to
                    // ~2k px. Hold the reader's message at its captured offset while the rows measure. The hold
                    // measures the element and applies only the remaining difference, so where the list already
                    // kept the place it writes nothing; a user gesture cancels it.
                    messageListRef.current?.holdViewportAnchor(snap.anchor, PREPEND_ANCHOR_HOLD);
                }
                updateTracking();
                return;
            }

            const heightDelta = container.scrollHeight - snap.height;
            const applyHeightDelta = (): boolean => {
                if (heightDelta <= 0) {
                    return false;
                }
                container.scrollTop = snap.top + heightDelta;
                return true;
            };

            // Non-virtualized mobile list only: fight iOS momentum manually.
            if (isMobileSurfaceRuntime() && heightDelta > 0) {
                setScrollTopDefeatingMomentum(container, snap.top + heightDelta);
                updateTracking();
                return;
            }

            // The unvirtualized list has no internal prepend compensation.
            if (!(snap.anchor && restoreViewportAnchor(snap.anchor))) {
                applyHeightDelta();
            }
        } else if (isPrepend && prev && !historyVirtualized) {
            // Released viewport: preserve the read position by compensating for the
            // exact height the prepend added above, with no intermediate frame for
            // auto-follow to fight. Virtualized lists skip this because TanStack
            // already owns keyed prepend preservation.
            const delta = container.scrollHeight - prev.scrollHeight;
            if (delta > 0) {
                const target = container.scrollTop + delta;
                if (isMobileSurfaceRuntime()) {
                    setScrollTopDefeatingMomentum(container, target);
                } else {
                    container.scrollTop = target;
                }
            }
        } else if (snap) {
            // setIsLoadingOlder/historyMeta can commit before the server page
            // arrives. Keep the snapshot armed, but refresh it so later fallback
            // compensation only accounts for rows actually prepended above.
            refreshPendingSnapshot();
        }

        updateTracking();
    }, [captureViewportAnchor, messageListRef, renderedMessages, scrollRef, restoreViewportAnchor, goToBottom]);

    const revealBufferedTurns = React.useCallback(async (): Promise<boolean> => false, []);

    const fetchOlderHistory = React.useCallback(async (input: {
        preserveViewport: boolean;
    }): Promise<boolean> => {
        if (!sessionIdRef.current || !timelineIdentityRef.current.key || isLoadingOlderRef.current) {
            return false;
        }
        if (!historySignalsRef.current.hasMoreAboveTurns) {
            return false;
        }

        const targetSessionId = sessionIdRef.current;
        const targetIdentity = timelineIdentityRef.current;
        if (!targetSessionId || !targetIdentity.key) {
            return false;
        }
        const clearOwnedPrependSnapshot = () => {
            if (prePrependScrollRef.current?.identity === targetIdentity) {
                prePrependScrollRef.current = null;
            }
        };

        const container = scrollRef.current;
        const beforeMessages = messagesRef.current;
        const beforeMessageCount = beforeMessages.length;
        const beforeOldestMessageId = beforeMessages[0]?.info?.id ?? null;
        const beforeLimit = historyMetaRef.current?.limit ?? getMemoryLimits().HISTORICAL_MESSAGES;

        // Store scroll snapshot BEFORE the fetch so useLayoutEffect can
        // compensate synchronously when React commits the new messages.
        if (input.preserveViewport && container) {
            prePrependScrollRef.current = {
                identity: targetIdentity,
                height: container.scrollHeight,
                top: container.scrollTop,
                anchor: captureViewportAnchor(),
                historyVirtualized: messageListRef.current?.isHistoryVirtualized() ?? false,
                oldestId: beforeOldestMessageId,
                newestId: beforeMessages[beforeMessages.length - 1]?.info?.id ?? null,
            };
        }

        beginHistoryInteraction();
        setIsLoadingOlder(true);
        // smarty-code#583: set before loading ends, so the effect that chains the next page sees it.
        recheckAfterLoadRef.current = false;

        try {
            let loadedMessageCount = beforeMessageCount;
            let loadedOldestMessageId = beforeOldestMessageId;
            let loadedLimit = beforeLimit;
            const beforeTurnCount = turnModelRef.current.turnCount;

            while (true) {
                await loadMoreMessages(targetSessionId, 'up');
                if (timelineIdentityRef.current !== targetIdentity) {
                    clearOwnedPrependSnapshot();
                    return false;
                }

                await waitForNextRenderCommitOrTimeout();
                if (timelineIdentityRef.current !== targetIdentity) {
                    clearOwnedPrependSnapshot();
                    return false;
                }

                const afterMessages = messagesRef.current;
                const afterMessageCount = afterMessages.length;
                const afterOldestMessageId = afterMessages[0]?.info?.id ?? null;
                const afterLimit = historyMetaRef.current?.limit ?? loadedLimit;
                const messageGrowth =
                    afterMessageCount > loadedMessageCount
                    || (typeof loadedOldestMessageId === 'string'
                        && typeof afterOldestMessageId === 'string'
                        && loadedOldestMessageId !== afterOldestMessageId)
                    || afterLimit > loadedLimit;
                const turnGrowth = turnModelRef.current.turnCount - beforeTurnCount;
                recheckAfterLoadRef.current = turnGrowth > 0 || messageGrowth;

                if (turnGrowth > 0) {
                    return true;
                }
                if (!messageGrowth) {
                    clearOwnedPrependSnapshot();
                    return false;
                }
                if (!historySignalsRef.current.hasMoreAboveTurns) {
                    return true;
                }
                // New rows that fill the viewport are enough; keep paging only while it is underfilled. Paging until a
                // user turn downloaded 15 MB of tool output for a tool-heavy session (smarty-code#116 pilot).
                const filled = scrollRef.current;
                if (filled && filled.scrollHeight > filled.clientHeight) {
                    return true;
                }

                loadedMessageCount = afterMessageCount;
                loadedOldestMessageId = afterOldestMessageId;
                loadedLimit = afterLimit;
            }
        } catch (error) {
            recheckAfterLoadRef.current = false;
            clearOwnedPrependSnapshot();
            throw error;
        } finally {
            if (timelineIdentityRef.current === targetIdentity) {
                setIsLoadingOlder(false);
                settleHistoryInteraction();
            }
        }
    }, [beginHistoryInteraction, captureViewportAnchor, loadMoreMessages, messageListRef, scrollRef, settleHistoryInteraction, waitForNextRenderCommitOrTimeout]);

    const loadEarlier = React.useCallback(async (options?: { userInitiated?: boolean }) => {
        const targetIdentity = timelineIdentityRef.current;
        beginHistoryInteraction();
        if (options?.userInitiated) {
            releaseAutoFollow();
        }

        try {
            void (await fetchOlderHistory({ preserveViewport: true }));
        } finally {
            if (timelineIdentityRef.current === targetIdentity) {
                settleHistoryInteraction();
            }
        }
    }, [beginHistoryInteraction, fetchOlderHistory, releaseAutoFollow, settleHistoryInteraction]);

    const handleHistoryScroll = React.useCallback(() => {
        // Mobile never loads history from scroll position: any prepend racing
        // an active touch gesture can be hijacked by the native scroll
        // animation. The user scrolls to the natural top and taps an explicit
        // "load older" button instead — the insert then happens from a resting
        // state, which is fully deterministic.
        if (isMobileSurfaceRuntime()) return;
        const container = scrollRef.current;
        if (!container) return;
        if (isPinnedRef.current) return;
        if (container.scrollTop >= resolveHistoryScrollThreshold(container.clientHeight)) return;
        if (!historySignalsRef.current.canLoadEarlier) return;
        if (isLoadingOlderRef.current || pendingRevealWorkRef.current) return;

        void loadEarlier({ userInitiated: true });
    }, [loadEarlier, scrollRef]);

    // smarty-code#583: the next older page may load as soon as the previous one is in. The scroll event that
    // reached the threshold fired while that page loaded, and a reader already at the top makes no further
    // scroll events, so check again once, on the next frame after a load that ADDED rows. A failed or empty
    // load waits for the user's next scroll, so it never retries in a loop (review/astra OC#303).
    React.useEffect(() => {
        if (isLoadingOlder || typeof window === 'undefined' || !recheckAfterLoadRef.current) return;
        recheckAfterLoadRef.current = false;
        const frame = window.requestAnimationFrame(() => handleHistoryScroll());
        return () => window.cancelAnimationFrame(frame);
    }, [handleHistoryScroll, isLoadingOlder]);

    const loadEarlierIfPinnedViewportUnderfilled = React.useCallback(() => {
        // On mobile the initial page is intentionally smaller. Auto-prepending
        // older rows after first paint shifts the narrow timeline; let explicit
        // upward scroll request history instead.
        if (isMobileSurfaceRuntime()) return;
        if (historyInteractionRef.current) return;
        const container = scrollRef.current;
        if (!container) return;
        if (!shouldAutoLoadEarlierForUnderfilledPinnedViewport({
            sessionId: sessionIdRef.current,
            isPinned: isPinnedRef.current,
            canLoadEarlier: historySignalsRef.current.canLoadEarlier,
            isLoadingOlder: isLoadingOlderRef.current,
            pendingRevealWork: pendingRevealWorkRef.current,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
        })) {
            return;
        }

        void loadEarlier();
    }, [loadEarlier, scrollRef]);

    React.useEffect(() => {
        if (typeof window === 'undefined') {
            return;
        }

        const frame = window.requestAnimationFrame(() => {
            loadEarlierIfPinnedViewportUnderfilled();
        });

        return () => window.cancelAnimationFrame(frame);
    }, [
        historySignals.canLoadEarlier,
        isLoadingOlder,
        isPinned,
        loadEarlierIfPinnedViewportUnderfilled,
        pendingRevealWork,
        renderedMessages.length,
        sessionKey,
    ]);

    React.useEffect(() => {
        if (typeof window === 'undefined' || typeof ResizeObserver === 'undefined') {
            return;
        }

        const container = scrollRef.current;
        if (!container) {
            return;
        }

        let frame: number | null = null;
        const scheduleCheck = () => {
            if (frame !== null) {
                return;
            }
            frame = window.requestAnimationFrame(() => {
                frame = null;
                loadEarlierIfPinnedViewportUnderfilled();
            });
        };

        const observer = new ResizeObserver(scheduleCheck);
        observer.observe(container);
        const content = container.firstElementChild;
        if (content instanceof Element) {
            observer.observe(content);
        }
        scheduleCheck();

        return () => {
            if (frame !== null) {
                window.cancelAnimationFrame(frame);
            }
            observer.disconnect();
        };
    }, [loadEarlierIfPinnedViewportUnderfilled, scrollNode, scrollRef, sessionKey]);

    // smarty-code#583 (review/astra OC#334): an explicit navigation is newer reader intent than a pending prepend's
    // anchor; drop the anchor so the page landing later does not hold the reader at the old place.
    const yieldPendingAnchor = React.useCallback(() => {
        const pending = prePrependScrollRef.current;
        if (pending) prePrependScrollRef.current = { ...pending, anchor: null, yielded: true };
    }, []);

    // While an older page is pending, a scroll the reader makes (wheel, touch, scrollbar, keys) re-captures the anchor
    // once it settles, so the hold after the page lands keeps where the reader is NOW, not where the request started.
    React.useEffect(() => {
        const container = scrollRef.current;
        if (!container || typeof window === 'undefined') return;
        let readerAt = 0;
        let frame: number | null = null;
        const onIntent = () => { readerAt = Date.now(); };
        const onScroll = () => {
            if (!prePrependScrollRef.current || Date.now() - readerAt > READER_SCROLL_WINDOW_MS || frame !== null) return;
            frame = window.requestAnimationFrame(() => {
                frame = null;
                const pending = prePrependScrollRef.current;
                if (pending && !pending.yielded) prePrependScrollRef.current = { ...pending, anchor: captureViewportAnchor() };
            });
        };
        for (const name of READER_INTENT_EVENTS) container.addEventListener(name, onIntent, { passive: true });
        container.addEventListener('scroll', onScroll, { passive: true });
        // Every return to latest drops a pending anchor, whichever path called it (review/astra OC#334).
        container.addEventListener(SCROLL_NAVIGATE_EVENT, yieldPendingAnchor);
        return () => {
            for (const name of READER_INTENT_EVENTS) container.removeEventListener(name, onIntent);
            container.removeEventListener('scroll', onScroll);
            container.removeEventListener(SCROLL_NAVIGATE_EVENT, yieldPendingAnchor);
            if (frame !== null) window.cancelAnimationFrame(frame);
        };
    }, [captureViewportAnchor, scrollNode, scrollRef, sessionKey, yieldPendingAnchor]);

    const scrollToTurn = React.useCallback(async (
        turnId: string,
        options?: { behavior?: ScrollBehavior },
    ): Promise<boolean> => {
        yieldPendingAnchor();
        if (!turnId || !sessionIdRef.current || !timelineIdentityRef.current.key) {
            return false;
        }

        const targetIdentity = timelineIdentityRef.current;
        releaseAutoFollow();
        setPendingRevealWork(true);

        try {
            if (timelineIdentityRef.current !== targetIdentity) {
                return false;
            }

            const turnIndex = turnModelRef.current.turnIndexById.get(turnId);
            if (typeof turnIndex !== 'number') {
                return false;
            }

            const result = await new Promise<boolean>((resolve) => {
                pendingScrollRequestRef.current = {
                    identity: targetIdentity,
                    kind: 'turn',
                    id: turnId,
                    behavior: options?.behavior ?? 'auto',
                    turnId,
                    resolve,
                };
                attemptPendingScrollRequest();
            });

            if (result) {
                return true;
            }

            return false;
        } finally {
            if (timelineIdentityRef.current === targetIdentity) {
                setPendingRevealWork(false);
            }
        }
    }, [attemptPendingScrollRequest, releaseAutoFollow, yieldPendingAnchor]);

    const scrollToMessage = React.useCallback(async (
        messageId: string,
        options?: { behavior?: ScrollBehavior },
    ): Promise<boolean> => {
        yieldPendingAnchor();
        if (!messageId || !sessionIdRef.current || !timelineIdentityRef.current.key) {
            return false;
        }

        const targetIdentity = timelineIdentityRef.current;
        releaseAutoFollow();
        setPendingRevealWork(true);

        try {
            if (timelineIdentityRef.current !== targetIdentity) {
                return false;
            }

            const turnId = turnModelRef.current.messageToTurnId.get(messageId);
            const turnIndex = turnModelRef.current.messageToTurnIndex.get(messageId);

            if (typeof turnIndex !== 'number') {
                return false;
            }

            const result = await new Promise<boolean>((resolve) => {
                pendingScrollRequestRef.current = {
                    identity: targetIdentity,
                    kind: 'message',
                    id: messageId,
                    behavior: options?.behavior ?? 'auto',
                    turnId: turnId ?? null,
                    resolve,
                };
                attemptPendingScrollRequest();
            });

            if (result) {
                return true;
            }

            return false;
        } finally {
            if (timelineIdentityRef.current === targetIdentity) {
                setPendingRevealWork(false);
            }
        }
    }, [attemptPendingScrollRequest, releaseAutoFollow, yieldPendingAnchor]);

    const resumeToBottom = React.useCallback(async () => {
        yieldPendingAnchor();
        setPendingRevealWork(false);
        setIsLoadingOlder(false);
        goToBottom('smooth');
    }, [goToBottom, yieldPendingAnchor]);

    const resumeToBottomInstant = React.useCallback(async () => {
        setPendingRevealWork(false);
        setIsLoadingOlder(false);
        goToBottom('instant');
    }, [goToBottom]);

    const handleActiveTurnChange = React.useCallback((turnId: string | null) => {
        const pin = scrollPinRef.current;
        if (pin) {
            if (turnId !== pin.turnId && Date.now() < pin.expiresAt) {
                return;
            }
            scrollPinRef.current = null;
        }
        setActiveTurnId(turnId);
    }, []);

    return {
        turnIds: turnWindowModel.turnIds,
        turnStart: 0,
        renderedMessages,
        historySignals,
        isLoadingOlder,
        pendingRevealWork,
        activeTurnId,
        showScrollToBottom: showScrollButton && !pendingRevealWork,
        turnWindowModel,
        loadEarlier,
        revealBufferedTurns,
        resumeToBottom,
        resumeToBottomInstant,
        scrollToTurn,
        scrollToMessage,
        handleHistoryScroll,
        captureViewportAnchor,
        restoreViewportAnchor,
        handleActiveTurnChange,
    };
};
