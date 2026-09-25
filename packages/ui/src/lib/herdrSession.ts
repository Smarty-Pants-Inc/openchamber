/**
 * Herdr's own view of a Smarty Code session row (smarty-code#126 (c)). The managed gateway adds these fields to the
 * stock session object; a stock server never sends them, so stock rows keep their usual markers.
 */
export type HerdrState = 'working' | 'blocked' | 'done' | 'idle' | 'unknown';
const STATES = new Set<string>(['working', 'blocked', 'done', 'idle', 'unknown']);

/** Herdr's state for the row's pane, or undefined for a stock row. A state this build does not know reads as unknown. */
export const readHerdrState = (session: unknown): HerdrState | undefined => {
  const value = (session as { herdrState?: unknown } | null | undefined)?.herdrState;
  if (typeof value !== 'string') return undefined;
  return STATES.has(value) ? value as HerdrState : 'unknown';
};

/** One distinct dot per Herdr state, as Herdr shows them apart. */
export const HERDR_STATE_DOT: Record<HerdrState, string> = {
  working: 'bg-primary',
  blocked: 'bg-[var(--status-warning)]',
  done: 'bg-[var(--status-success)]',
  idle: 'bg-muted-foreground/40',
  unknown: 'border border-muted-foreground/60 bg-transparent',
};

/** A Pi that Herdr shows without a session identity: there are no messages to show, and nothing to attach. */
export const isHerdrNoIdentity = (session: unknown): boolean =>
  (session as { herdrNoIdentity?: unknown } | null | undefined)?.herdrNoIdentity === true;

/** The Herdr fields, for change detection: a state-only update must still reach the row (OC#177 review). */
export const herdrSignature = (session: unknown): string =>
  `${readHerdrState(session) ?? ''}/${isHerdrNoIdentity(session) ? 1 : 0}`;
