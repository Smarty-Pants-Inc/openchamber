import type { Range } from '@/sync/position-windows';

/** A window of positions to read (smarty-code#583). */
export type Window = { start: number; limit: number };
/** Proximity demand names the chunk that triggered its windows; explicit navigation has no trigger. */
export type WindowRequest = (windows: Window[], trigger?: Range) => void;

/**
 * smarty-code#583: one window read at a time for one session, and only the latest request waits: windows asked for
 * while a read runs are places the reader has already left. A request is a list read in order (the window the reader
 * reaches first, then the one after it). `current` says whether this session is still the one shown;
 * once it is not, the queue reads nothing more (a slow read of session A never carries session B's requests).
 * A queued proximity bundle is discarded if its triggering chunk is covered before dispatch. Once admitted, it keeps
 * its designed read-ahead, even when the first window covers the chunk.
 */
export function createWindowQueue(read: (start: number, limit: number) => Promise<void>, current: () => boolean,
    unloaded: (trigger: Range) => boolean = () => true): WindowRequest {
    let busy = false;
    let next: { windows: Window[]; trigger?: Range } | undefined;
    const hasReplacement = () => {
        // A covered repeat must not displace the admitted bundle's remaining read-ahead.
        if (next?.trigger && !unloaded(next.trigger)) next = undefined;
        return next !== undefined;
    };
    return (windows, trigger): void => {
        next = { windows: [...windows], trigger };
        if (busy) return;
        busy = true;
        void (async () => {
            while (next && current()) {
                const demand = next;
                next = undefined;
                // Read loader coverage now, not React's last render: the queue can resume before unmount cleanup.
                if (demand.trigger && !unloaded(demand.trigger)) continue;
                for (const { start, limit } of demand.windows) {
                    if (!current() || hasReplacement()) break;
                    await read(start, limit).catch(() => undefined);
                }
            }
            next = undefined;
            busy = false;
        })();
    };
}
