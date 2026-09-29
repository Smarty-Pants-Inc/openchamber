/** A window of positions to read (smarty-code#583). */
export type Window = { start: number; limit: number };

/**
 * smarty-code#583: one window read at a time for one session, and only the latest request waits: windows asked for
 * while a read runs are places the reader has already left. A request is a list read in order (the window the reader
 * reaches first, then the one after it). `current` says whether this session is still the one shown;
 * once it is not, the queue reads nothing more (a slow read of session A never carries session B's requests).
 */
export function createWindowQueue(read: (start: number, limit: number) => Promise<void>, current: () => boolean) {
    let busy = false;
    let next: Window[] = [];
    return (windows: Window[]): void => {
        next = [...windows];
        if (busy) return;
        busy = true;
        void (async () => {
            while (next.length && current()) {
                const { start, limit } = next.shift()!;
                await read(start, limit).catch(() => undefined);
            }
            next = [];
            busy = false;
        })();
    };
}
