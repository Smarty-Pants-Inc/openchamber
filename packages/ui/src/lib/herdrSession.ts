import type { Session } from '@opencode-ai/sdk/v2';
/**
 * Herdr's own view of a Smarty Code session row (smarty-code#126 (c)). The managed gateway adds these fields to the
 * stock session object; a stock server never sends them, so stock rows keep their usual markers.
 */
export type HerdrState = 'working' | 'blocked' | 'done' | 'idle' | 'unknown' | 'ended';
/** 'ended': a Code-created session whose Pi has ended; the gateway lists it read-only from its transcript. */
const STATES = new Set<string>(['working', 'blocked', 'done', 'idle', 'unknown', 'ended']);

/** Herdr's state for the row's pane, or undefined for a stock row. A state this build does not know reads as unknown. */
export const readHerdrState = (session: unknown): HerdrState | undefined => {
  const value = (session as { herdrState?: unknown } | null | undefined)?.herdrState;
  if (typeof value !== 'string') return undefined;
  return STATES.has(value) ? value as HerdrState : 'unknown';
};

/**
 * smarty-code#1140: the row's state with the session's native status applied. Herdr's state is a sample the gateway
 * re-reads every 2 s (17-59 s under load); the native busy/idle status reaches the page as an event, but its idle comes
 * only after 2 s of owner idleness. So Working follows native busy, and done takes whichever comes FIRST: Herdr's done
 * (when it changed after native busy) or native idle. Herdr keeps what only it knows (blocked, ended) and is the
 * fallback where there is no native status. No new polling.
 */
export const liveHerdrState = (herdr: HerdrState | undefined, native: string | undefined, herdrIsNewer = false): HerdrState | undefined => {
  if (!herdr || !native || herdr === 'blocked' || herdr === 'ended') return herdr;
  if (native === 'busy' || native === 'retry') return herdrIsNewer && (herdr === 'done' || herdr === 'idle') ? herdr : 'working';
  return native === 'idle' && herdr === 'working' ? 'done' : herdr;
};

/**
 * Which of a row's two inputs changed last, per session, kept across row remounts (scroll, collapse). The same values
 * twice are no change, so a double render cannot reorder them. A row first seen has no order: native wins.
 */
const changeOrder = new Map<string, { herdr?: HerdrState; native?: string; herdrAt: number; nativeAt: number }>();
let changeTick = 0;
const MAX_ORDERED_SESSIONS = 2048;
export const herdrChangedLast = (sessionId: string, herdr: HerdrState | undefined, native: string | undefined): boolean => {
  const o = changeOrder.get(sessionId);
  if (!o) {
    if (changeOrder.size >= MAX_ORDERED_SESSIONS) changeOrder.delete(changeOrder.keys().next().value!);
    changeOrder.set(sessionId, { herdr, native, herdrAt: 0, nativeAt: 0 });
    return false;
  }
  if (o.herdr !== herdr) { o.herdr = herdr; o.herdrAt = ++changeTick; }
  if (o.native !== native) { o.native = native; o.nativeAt = ++changeTick; }
  return o.herdrAt > o.nativeAt;
};

/** One distinct dot per Herdr state, as Herdr shows them apart. */
export const HERDR_STATE_DOT: Record<HerdrState, string> = {
  working: 'bg-primary',
  blocked: 'bg-[var(--status-warning)]',
  done: 'bg-[var(--status-success)]',
  idle: 'bg-muted-foreground/40',
  unknown: 'border border-muted-foreground/60 bg-transparent',
  ended: 'bg-muted-foreground/15',
};

/** A Code-created session whose Pi has ended: read-only, with that plain reason. */
export const isHerdrEnded = (session: Session | null | undefined): boolean => readHerdrState(session) === 'ended';

/**
 * The chat shows the View only banner instead of the composer: its history read said read-only, OR the open session's own
 * row says its Pi has ended (smarty-code#811: the gateway pushes that state at once, but the history read that sets the
 * read-only flag is not repeated while the page stays open, so the composer stayed as if the Pi were live). `globalEnded`: the
 * managed listing's row says ended; the open directory row can miss that update on a busy fleet (#811 on 3.53).
 */
export const showsViewOnly = (historyReadOnly: boolean | undefined, session: Session | null | undefined, globalEnded = false): boolean =>
  (historyReadOnly === true && !isOrdinaryCodeMade(session)) || isHerdrEnded(session) || globalEnded;

/**
 * A Code-made session that is unavailable (its Pi stopped or lost Code's bridge in an open pane; smarty-code#957): its
 * history is read-only for now, but it is not a fleet session "started in Herdr". It keeps its composer, with Send off
 * and its reason (#790), until its Pi is back. Ended is still View only.
 */
export const isOrdinaryCodeMade = (session: unknown): boolean =>
  (session as { ordinaryCodeMade?: unknown } | null | undefined)?.ordinaryCodeMade === true;
/** Its composer says the Pi lost Code's connection and how to reconnect (smarty-code#957). An ended session has its own
 * words, and a reloading one says it is reloading (#870; openchamber#411 r3: a healthy /reload is no disconnect). */
export const isPiDisconnected = (session: Session | null | undefined): boolean =>
  isOrdinaryCodeMade(session) && !isHerdrEnded(session) && !isOrdinaryReloading(session);

/** A Pi that Herdr shows without a session identity: there are no messages to show, and nothing to attach. */
export const isHerdrNoIdentity = (session: unknown): boolean =>
  (session as { herdrNoIdentity?: unknown } | null | undefined)?.herdrNoIdentity === true;

/**
 * The session that replaced this one: a new pane's Pi is first listed by its pane, then re-keyed once it reports its
 * session id; the gateway marks the old record with the new id (smarty-code#863).
 */
export const herdrSuccessorOf = (session: unknown): string | undefined => {
  const value = (session as { herdrSuccessor?: unknown } | null | undefined)?.herdrSuccessor;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

/** The session to open instead of the viewed one, once its record names a successor (smarty-code#863). */
export const successorTarget = (currentId: string | null | undefined, sessions: readonly unknown[]): string | undefined => {
  if (!currentId) return undefined;
  const current = sessions.find((session) => (session as { id?: unknown } | null)?.id === currentId);
  const next = herdrSuccessorOf(current);
  return next && next !== currentId ? next : undefined;
};

/** A fleet Pi reloading (smarty-code#870): unavailable only until its reload finishes; not the View-only case. */
export const isOrdinaryReloading = (session: unknown): boolean =>
  (session as { ordinaryReloading?: unknown } | null | undefined)?.ordinaryReloading === true;

/** The Herdr fields, for change detection: a state-only update must still reach the row (OC#177 review). */
export const herdrSignature = (session: unknown): string =>
  `${readHerdrState(session) ?? ''}/${isHerdrNoIdentity(session) ? 1 : 0}/${herdrSuccessorOf(session) ?? ''}/${isOrdinaryReloading(session) ? 1 : 0}/${isOrdinaryCodeMade(session) ? 1 : 0}`;
