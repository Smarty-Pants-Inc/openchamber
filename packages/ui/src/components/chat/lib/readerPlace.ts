/** What a remounted timeline needs to put the reader back (smarty-code#583, openchamber#457 review 1). */
export type ReaderPlace = { key: string; viewOffset: number };
type ListState = { isAtEnd: boolean; start: number; scroll: number; data: readonly { key: string }[]; positionAtIndex: (index: number) => number };

/**
 * The reader's place in the list before it is replaced: undefined when the reader is at the latest rows (the new list
 * opens at its end, as before), else the first row in view and how far its top sits from the view's top.
 */
export function readerPlace(state: ListState | undefined, measure?: (key: string) => number | undefined): ReaderPlace | undefined {
    if (!state || state.isAtEnd) return undefined;
    const entry = state.data[state.start];
    if (!entry) return undefined;
    // The row's top as the reader SEES it, relative to the scroller: positionAtIndex is relative to the item area and
    // leaves out the list header (mobile's 'Load older'), while scroll counts it (openchamber#457 review 2). The mounted
    // row is measured when it can be; the item-area arithmetic is the fallback.
    const seen = measure?.(entry.key);
    return { key: entry.key, viewOffset: seen ?? state.positionAtIndex(state.start) - state.scroll };
}

/** The DOM element of a timeline entry, by its key (turn:, msg:, gap:), for measuring it. */
export function entrySelector(key: string): string | undefined {
    const [kind, ...rest] = key.split(':'); const id = rest.join(':');
    if (!id) return undefined;
    if (kind === 'turn') return `[data-turn-id=${JSON.stringify(id)}]`;
    if (kind === 'msg') return `[data-message-id=${JSON.stringify(id)}]`;
    return undefined;
}

/** The new list's first scroll: at the reader's row when it is in the new entries, else at the end. */
export function initialScrollFor(place: ReaderPlace | undefined, entries: readonly { key: string }[]) {
    const index = place ? entries.findIndex((entry) => entry.key === place.key) : -1;
    return index >= 0 ? { initialScrollAtEnd: false, initialScrollIndex: { index, viewOffset: place!.viewOffset } } : { initialScrollAtEnd: true };
}
