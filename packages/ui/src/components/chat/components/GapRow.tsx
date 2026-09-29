import React from 'react';

import type { GapEntry } from '../lib/turns/renderEntries';
import { gapWindow } from '../lib/gapWindow';

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
    // The chunk by value: the row object is rebuilt on each list render, and re-observing then restarted the settle timer.
    const { key, start, end, gapStart, gapEnd, heightPx } = gap;
    React.useEffect(() => {
        const chunk: GapEntry = { kind: 'gap', key, start, end, gapStart, gapEnd, heightPx };
        const node = ref.current;
        if (!node || !onLoadWindow || typeof IntersectionObserver === 'undefined') return;
        const root = node.closest<HTMLElement>('[data-scrollbar="chat"]');
        let timer: ReturnType<typeof setTimeout> | undefined;
        const load = () => {
            const box = node.getBoundingClientRect(), view = root?.getBoundingClientRect();
            const viewTop = view?.top ?? 0, viewBottom = view?.bottom ?? window.innerHeight;
            const next = gapWindow(chunk, { top: box.top, bottom: box.bottom }, { top: viewTop, bottom: viewBottom });
            onLoadWindow(next.start, next.end - next.start);
        };
        const observer = new IntersectionObserver((entries) => {
            const seen = entries[entries.length - 1];
            clearTimeout(timer);
            // Only a gap the reader stays near is read: a scrollbar drag passes dozens of gaps, and reading each one
            // queued their reads ahead of the one the reader stopped at (1-4 s on the candidate).
            if (seen?.isIntersecting) timer = setTimeout(load, GAP_SETTLE_MS);
        }, {
            root,
            // Two screens ahead in each direction: the window is read before the reader reaches the placeholder
            // (continuous scrolling at ~2,800 px/s outran reads started only once a placeholder was on screen).
            rootMargin: '200% 0px',
        });
        observer.observe(node);
        return () => { clearTimeout(timer); observer.disconnect(); };
    }, [key, start, end, gapStart, gapEnd, heightPx, onLoadWindow]);
    return (
        <div ref={ref} data-history-gap={`${gap.start}-${gap.end}`} aria-hidden
            className="chat-message-column" style={{ height: gap.heightPx }}>
            <div className="sticky top-2 mx-auto h-4 w-40 animate-pulse rounded bg-muted/50" />
        </div>
    );
}
