import React from 'react';

import type { GapEntry } from '../lib/turns/renderEntries';
import { GAP_SCROLL_READ_MS, GAP_SETTLE_MS, gapWindows } from '../lib/gapWindow';
import type { WindowRequest } from '../lib/windowQueue';

/** How long a gap stays on screen before it is read (smarty-code#583). */

/**
 * smarty-code#583: records of the session not loaded yet, drawn at their estimated height so the list is as long as the
 * whole session. When it comes on screen it asks for the window the reader needs: its end when the reader scrolls up
 * into it from below, its start when scrolling down into it, or around the point the reader landed on (a jump or a
 * scrollbar drag). The loaded records then take its place.
 */
export function GapRow({ gap, onLoadWindow }: { gap: GapEntry; onLoadWindow?: WindowRequest }) {
    const ref = React.useRef<HTMLDivElement | null>(null);
    // The chunk by value: the row object is rebuilt on each list render, and re-observing then restarted the settle timer.
    const { key, start, end, gapStart, gapEnd, heightPx } = gap;
    React.useEffect(() => {
        const chunk: GapEntry = { kind: 'gap', key, start, end, gapStart, gapEnd, heightPx };
        const node = ref.current;
        if (!node || !onLoadWindow || typeof IntersectionObserver === 'undefined') return;
        const root = node.closest<HTMLElement>('[data-scrollbar="chat"]');
        let timer: ReturnType<typeof setTimeout> | undefined, near = false, lastLoad = 0;
        const load = () => {
            lastLoad = Date.now();
            const box = node.getBoundingClientRect(), view = root?.getBoundingClientRect();
            const viewTop = view?.top ?? 0, viewBottom = view?.bottom ?? window.innerHeight;
            onLoadWindow(gapWindows(chunk, { top: box.top, bottom: box.bottom }, { top: viewTop, bottom: viewBottom }), { start, end });
        };
        // A placeholder taller than the view stays intersecting while the reader scrolls through it, so the observer does
        // not fire again: the window around the reader's new place was never read, and the list stayed blank for the
        // whole scroll (#583 dry run on 3.59, candidate 11:3xZ). While it is near, each scroll reads the window where the
        // reader is now: after the settle delay (a drag), and at least every GAP_SCROLL_READ_MS during a continuous wheel.
        const onScroll = () => {
            if (!near) return;
            clearTimeout(timer);
            if (Date.now() - lastLoad >= GAP_SCROLL_READ_MS) load();
            else timer = setTimeout(load, GAP_SETTLE_MS);
        };
        root?.addEventListener('scroll', onScroll, { passive: true });
        const observer = new IntersectionObserver((entries) => {
            const seen = entries[entries.length - 1];
            clearTimeout(timer);
            near = !!seen?.isIntersecting;
            // Only a gap the reader stays near is read: a scrollbar drag passes dozens of gaps, and reading each one
            // queued their reads ahead of the one the reader stopped at (1-4 s on the candidate).
            if (near) timer = setTimeout(load, GAP_SETTLE_MS);
        }, {
            root,
            // Two screens ahead in each direction: the window is read before the reader reaches the placeholder
            // (continuous scrolling at ~2,800 px/s outran reads started only once a placeholder was on screen).
            rootMargin: '200% 0px',
        });
        observer.observe(node);
        return () => { clearTimeout(timer); observer.disconnect(); root?.removeEventListener('scroll', onScroll); };
    }, [key, start, end, gapStart, gapEnd, heightPx, onLoadWindow]);
    return (
        <div ref={ref} data-history-gap={`${gap.start}-${gap.end}`} aria-hidden
            className="chat-message-column" style={{ height: gap.heightPx }}>
            <div className="sticky top-2 mx-auto h-4 w-40 animate-pulse rounded bg-muted/50" />
        </div>
    );
}
