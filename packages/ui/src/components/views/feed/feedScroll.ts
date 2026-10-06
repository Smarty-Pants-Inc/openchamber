// smarty-code#1407: the Timeline's jumps in the Feed transcript (entries carry data-feed-message-id and data-feed-entry).

/** Scrolls the transcript to a message's entry; false when the Feed does not show that message. */
export function scrollToFeedEntry(scroller: HTMLElement | null, messageId: string): boolean {
  const entry = Array.from(scroller?.querySelectorAll<HTMLElement>('[data-feed-message-id]') ?? []).find(element => element.dataset.feedMessageId === messageId);
  if (!entry) return false;
  entry.scrollIntoView({ block: 'start' });
  return true;
}

/** The Timeline's "previous turn": the person's message before the one at the top of the transcript. */
export function scrollFeedByTurn(scroller: HTMLElement | null, offset: number): void {
  if (!scroller) return;
  const turns = Array.from(scroller.querySelectorAll<HTMLElement>('[data-feed-entry="user"]'));
  const top = scroller.getBoundingClientRect().top;
  let current = -1;
  turns.forEach((turn, index) => { if (turn.getBoundingClientRect().top - top <= 1) current = index; });
  turns[Math.max(0, Math.min(turns.length - 1, current + offset))]?.scrollIntoView({ block: 'start' });
}
