/** What a remounted timeline needs to put the reader back (smarty-code#583, openchamber#457 review 1). */
export type ReaderPlace = { key: string; viewOffset: number };
type ListState = { isAtEnd: boolean; start: number; scroll: number; data: readonly { key: string }[]; positionAtIndex: (index: number) => number };

/**
 * The reader's place in the list before it is replaced: undefined when the reader is at the latest rows (the new list
 * opens at its end, as before), else the first row in view and how far its top sits from the view's top.
 */
export function readerPlace(state: ListState | undefined): ReaderPlace | undefined {
    if (!state || state.isAtEnd) return undefined;
    const entry = state.data[state.start];
    return entry ? { key: entry.key, viewOffset: state.positionAtIndex(state.start) - state.scroll } : undefined;
}

/** The new list's first scroll: at the reader's row when it is in the new entries, else at the end. */
export function initialScrollFor(place: ReaderPlace | undefined, entries: readonly { key: string }[]) {
    const index = place ? entries.findIndex((entry) => entry.key === place.key) : -1;
    return index >= 0 ? { initialScrollAtEnd: false, initialScrollIndex: { index, viewOffset: place!.viewOffset } } : { initialScrollAtEnd: true };
}
