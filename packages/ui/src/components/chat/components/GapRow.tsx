import React from 'react';

import type { GapEntry } from '../lib/turns/renderEntries';
import { windowFor } from '@/sync/position-windows';

/** Records read per window (the range read's target size, smarty-code#583). */
export const WINDOW_RECORDS = 200;
/** How long a gap stays on screen before it is read (smarty-code#583). */
const GAP_SETTLE_MS = 90;

/**
 * smarty-code#583: records of the session not loaded yet, drawn at their estimated height so the list is as long as the
 * whole session. When it comes on screen it asks for the window the reader needs: its end when the reader scrolls up
 * into it from below, its start when scrolling down into it, or around the point the reader landed on (a jump or a
 * scrollbar drag). The loaded records then take its place.
 */
export function GapRow({ gap, onLoadWindow }: { gap: GapEntry; onLoadWindow?: (start: number, limit: number) => void }) {
    const ref = React.useRef<HTMLDivElement | null>(null);
    React.useEffect(() => {
        const node = ref.current;
        if (!node || !onLoadWindow || typeof IntersectionObserver === 'undefined') return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const load = (view: DOMRectReadOnly | null) => {
            const box = node.getBoundingClientRect();
            const viewTop = view?.top ?? 0, viewBottom = view?.bottom ?? window.innerHeight;
            if (box.bottom < viewTop || box.top > viewBottom) return;
            const range = { start: gap.start, end: gap.end };
            const target = box.bottom <= viewBottom && box.bottom >= viewTop ? { edge: 'end' as const }
                : box.top >= viewTop && box.top <= viewBottom ? { edge: 'start' as const }
                    : { fraction: ((viewTop + viewBottom) / 2 - box.top) / Math.max(1, box.height) };
            const next = windowFor(range, WINDOW_RECORDS, target);
            onLoadWindow(next.start, next.end - next.start);
        };
        const observer = new IntersectionObserver((entries) => {
            const seen = entries[entries.length - 1];
            clearTimeout(timer);
            // Only a gap the reader stays on is read: a scrollbar drag passes dozens of gaps, and reading each one
            // queued their reads ahead of the one the reader stopped at (1-4 s on the candidate).
            if (seen?.isIntersecting) timer = setTimeout(() => load(seen.rootBounds), GAP_SETTLE_MS);
        });
        observer.observe(node);
        return () => { clearTimeout(timer); observer.disconnect(); };
    }, [gap.start, gap.end, onLoadWindow]);
    return (
        <div ref={ref} data-history-gap={`${gap.start}-${gap.end}`} aria-hidden
            className="chat-message-column" style={{ height: gap.heightPx }}>
            <div className="sticky top-2 mx-auto h-4 w-40 animate-pulse rounded bg-muted/50" />
        </div>
    );
}
