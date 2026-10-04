// Scroll geometry for the chat timeline.
//
// The timeline has three mutually exclusive scroll modes:
//
//   • `following-end`      — stay pinned to the live edge as content grows.
//   • `anchoring-new-turn` — park the just-sent user row near the top until
//     the reply outgrows the usable viewport.
//   • `free-scrolling`     — the user took over; nothing moves the scroll
//     position until they opt back in.
//
// This module is pure geometry: it reads measurements from the virtualized
// list and answers where the real content ends and whether the viewport is
// there. Keeping it free of DOM and React makes the rules testable without a
// renderer.

export type TimelineScrollMode = 'following-end' | 'anchoring-new-turn' | 'free-scrolling';

// Leave the send row clear of the timeline's top fade.
export const CHAT_LIST_ANCHOR_OFFSET = 16;

export interface AnchoredTurnMetrics {
    readonly anchorTop: number;
    readonly lastBottom: number;
    readonly turnHeight: number;
    readonly usableViewportHeight: number;
    readonly visibleUsableBottom: number;
    readonly overflowsUsableViewport: boolean;
    readonly targetScrollToRevealEnd: number;
    readonly scrollDeltaToRevealEnd: number;
}

export interface TimelineListMeasurementState {
    readonly data: readonly unknown[];
    readonly scroll: number;
    readonly scrollLength: number;
    readonly positionAtIndex: (index: number) => number | undefined;
    readonly sizeAtIndex: (index: number) => number | undefined;
}

export const getRowBottom = (
    state: TimelineListMeasurementState,
    index: number,
): number | null => {
    const top = state.positionAtIndex(index);
    const height = state.sizeAtIndex(index);
    if (
        top === undefined
        || height === undefined
        || !Number.isFinite(top)
        || !Number.isFinite(height)
    ) {
        return null;
    }
    // Rows measured at zero height would read as no content at all; treat
    // them as one pixel tall instead.
    return top + Math.max(1, height);
};

export const getAnchoredTurnMetrics = ({
    state,
    anchorIndex,
    composerOverlayHeight,
    anchorOffset,
    footerSize = 0,
}: {
    readonly state: TimelineListMeasurementState;
    readonly anchorIndex: number;
    readonly composerOverlayHeight: number;
    readonly anchorOffset: number;
    readonly footerSize?: number;
}): AnchoredTurnMetrics | null => {
    if (state.data.length === 0) return null;

    const boundedAnchorIndex = Math.max(0, Math.min(anchorIndex, state.data.length - 1));
    const anchorTop = state.positionAtIndex(boundedAnchorIndex);
    // Reserved anchored end space is not content; the actual footer is.
    const rowBottom = getRowBottom(state, state.data.length - 1);
    if (anchorTop === undefined || !Number.isFinite(anchorTop) || rowBottom === null) {
        return null;
    }
    const lastBottom = rowBottom + Math.max(0, footerSize);
    const usableViewportHeight = Math.max(0, state.scrollLength - composerOverlayHeight - anchorOffset);
    const turnHeight = Math.max(0, lastBottom - anchorTop);
    const visibleUsableBottom = state.scroll + usableViewportHeight;
    const targetScrollToRevealEnd = Math.max(0, lastBottom - usableViewportHeight);
    // Never scroll backwards to reveal the end.
    const scrollDeltaToRevealEnd = Math.max(0, targetScrollToRevealEnd - state.scroll);

    return {
        anchorTop,
        lastBottom,
        turnHeight,
        usableViewportHeight,
        visibleUsableBottom,
        overflowsUsableViewport: turnHeight > usableViewportHeight,
        targetScrollToRevealEnd,
        scrollDeltaToRevealEnd,
    };
};

// The list footer (question and permission cards, error notices, the tail
// spacer) renders after the last row and is part of the real content; the
// list does not expose its size through getState, so the caller passes the
// last reported value.
export const resolveRealContentEndOffset = ({
    state,
    composerOverlayHeight,
    footerSize = 0,
    extraInset = 0,
}: {
    readonly state: TimelineListMeasurementState;
    readonly composerOverlayHeight: number;
    readonly footerSize?: number;
    readonly extraInset?: number;
}): number | null => {
    const lastIndex = state.data.length - 1;
    if (lastIndex < 0) return null;
    const lastBottom = getRowBottom(state, lastIndex);
    if (lastBottom === null) return null;
    const visibleLength = Math.max(0, state.scrollLength - composerOverlayHeight - extraInset);
    return Math.max(0, lastBottom + Math.max(0, footerSize) - visibleLength);
};

// Keep return-to-end detection in a tight band, rather than half a viewport.
export const TIMELINE_FOLLOW_REARM_THRESHOLD_PX = 40;

export const resolveTimelineIsAtEnd = (
    state: {
        readonly contentLength?: number;
        readonly scroll?: number;
        readonly scrollLength?: number;
        readonly isNearEnd?: boolean;
        readonly isAtEnd?: boolean;
    } | undefined,
): boolean | undefined => {
    if (!state) return undefined;
    const { contentLength, scroll, scrollLength } = state;
    if (
        contentLength !== undefined
        && scroll !== undefined
        && scrollLength !== undefined
        && Number.isFinite(contentLength)
    ) {
        return contentLength - (scroll + scrollLength) <= TIMELINE_FOLLOW_REARM_THRESHOLD_PX;
    }
    return state.isNearEnd ?? state.isAtEnd;
};

export interface ChatListAnchoredEndSpace {
    readonly anchorIndex: number;
    readonly anchorOffset: number;
}

// A retried message can occur twice; anchor its last, live row.
export const resolveChatListAnchoredEndSpace = <Item, AnchorId>(
    items: readonly Item[],
    anchorId: AnchorId | null,
    getAnchorId: (item: Item) => AnchorId | null,
    options: { readonly anchorOffset?: number } = {},
): ChatListAnchoredEndSpace | undefined => {
    if (anchorId === null) return undefined;
    for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        if (item !== undefined && getAnchorId(item) === anchorId) {
            return { anchorIndex: index, anchorOffset: options.anchorOffset ?? CHAT_LIST_ANCHOR_OFFSET };
        }
    }
    return undefined;
};
