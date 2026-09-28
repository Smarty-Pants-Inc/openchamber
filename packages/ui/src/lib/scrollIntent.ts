/**
 * Events on a scroll container for input that does not reach it as a native event (smarty-code#583, review/astra
 * OC#334): the overlay scrollbar's thumb lives outside the container, and "return to latest" is a button elsewhere.
 * - SCROLL_INTENT_EVENT: the reader is moving the view themselves (a thumb drag).
 * - SCROLL_NAVIGATE_EVENT: an explicit navigation (return to latest) takes over the view.
 */
export const SCROLL_INTENT_EVENT = 'smarty:scroll-intent';
export const SCROLL_NAVIGATE_EVENT = 'smarty:scroll-navigate';

export const signalScroll = (container: EventTarget | null | undefined, name: string): void => {
    if (container && typeof Event !== 'undefined') container.dispatchEvent(new Event(name));
};
