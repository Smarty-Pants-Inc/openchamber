/**
 * smarty-code#583: one window read at a time for one session, and only the latest request waits: windows asked for
 * while a read runs are places the reader has already left. `current` says whether this session is still the one shown;
 * once it is not, the queue reads nothing more (a slow read of session A never carries session B's requests).
 */
export function createWindowQueue(read: (start: number, limit: number) => Promise<void>, current: () => boolean) {
    let busy = false;
    let next: [number, number] | null = null;
    return (start: number, limit: number): void => {
        next = [start, limit];
        if (busy) return;
        busy = true;
        void (async () => {
            while (next && current()) {
                const [start, limit] = next;
                next = null;
                await read(start, limit).catch(() => undefined);
            }
            next = null;
            busy = false;
        })();
    };
}
