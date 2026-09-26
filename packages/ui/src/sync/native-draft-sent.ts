import React from 'react';
import { consumeChatDraft, createChatDraftIdentity, readChatDraft } from '@/lib/chatDraftPersistence';
import { opencodeClient } from '@/lib/opencode/client';
import { z } from 'zod';

const markerSchema = z.object({ clientRequestId: z.string().min(1), admitted: z.literal(true).optional(),
  text: z.string().optional(), at: z.number().optional() });

/**
 * A Send whose session start the server accepted (202, its client request id echoed) owns the new-session draft's
 * text until that start resolves (#117, closed tab). The mark is in localStorage, so every tab sees it. Resolving it only
 * reads the start and its session's history, never answers or continues it.
 * - While a tab is in its Send attempt for that request, it holds a Web Lock named after the request: other tabs show
 *   the text as pending (read-only, no way to edit it).
 * - An admitted (or found delivered) Send keeps the mark, flagged admitted with its text, for ADMITTED_MS: every tab
 *   that holds a live copy consumes that text through its own draft generation before it unlocks. Nothing but a
 *   stopped start removes a mark early.
 * - Only a stopped start (expired, denied, cancelled) proves the text was not sent: it is restored as unsent. Anything
 *   else not proven (no user message yet, no live sender, not readable) is unknown: read-only until the person
 *   explicitly edits it as an unsent message.
 */
export type SentStartOutcome = 'resolving' | 'pending' | 'unknown' | 'stopped';
type Marker = z.infer<typeof markerSchema>;
type Resolved = SentStartOutcome | 'delivered' | null;

const STOPPED = ['denied', 'cancelled', 'expired'];
const slot = (runtimeKey: string, directory: string) => JSON.stringify([runtimeKey, directory]);
const storageKey = (runtimeKey: string, directory: string) => `oc.nativeCreation.sent:${slot(runtimeKey, directory)}`;
const lockName = (id: string) => `oc.nativeCreation.sending:${id}`;
const ADMITTED_MS = 600_000;
/** Admitted marks this page already consumed from (or sent itself): a later draft with the same text is never touched. */
const handled = new Set<string>();
const outcomes = new Map<string, SentStartOutcome>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
/** The requests this page is sending (its locks), by request id. */
const sending = new Map<string, () => void>();

function readMarker(runtimeKey: string, directory: string): Marker | undefined {
  try {
    const parsed = markerSchema.safeParse(JSON.parse(localStorage.getItem(storageKey(runtimeKey, directory)) ?? 'null'));
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}
const writeMarker = (runtimeKey: string, directory: string, marker: Marker | null) => {
  try {
    if (marker) localStorage.setItem(storageKey(runtimeKey, directory), JSON.stringify(marker));
    else localStorage.removeItem(storageKey(runtimeKey, directory));
  } catch { /* no storage */ }
};
const locks = (): LockManager | undefined => globalThis.navigator?.locks;

/** This page is in a Send attempt for the request: hold its lock until releaseSentStart. */
export function holdSentStart(clientRequestId: string): void {
  if (sending.has(clientRequestId)) return;
  let release = () => {};
  const done = new Promise<void>(resolve => { release = resolve; });
  sending.set(clientRequestId, release);
  void locks()?.request(lockName(clientRequestId), () => done).catch(() => undefined);
}

/** This page's Send attempt for the request ended (admitted, refused, stopped or given up). The mark stays. */
export function releaseSentStart(clientRequestId: string | undefined): void {
  if (!clientRequestId) return;
  sending.get(clientRequestId)?.();
  sending.delete(clientRequestId);
}

/** The start for this Send was accepted: its text is sent, not an ordinary draft, until the start resolves. */
export function markSentStart(runtimeKey: string, directory: string, clientRequestId: string): void {
  writeMarker(runtimeKey, directory, { clientRequestId });
  holdSentStart(clientRequestId);
}

/**
 * This request's Send was admitted with the composer text it submitted: other tabs consume their copies of that text.
 */
export function admitSentStart(runtimeKey: string, directory: string, clientRequestId: string | undefined, submitted?: string): void {
  releaseSentStart(clientRequestId);
  if (clientRequestId && readMarker(runtimeKey, directory)?.clientRequestId === clientRequestId) {
    handled.add(clientRequestId);
    writeMarker(runtimeKey, directory, submitted === undefined ? { clientRequestId, admitted: true, at: Date.now() }
      : { clientRequestId, admitted: true, text: submitted, at: Date.now() });
  }
}

/** Clears only the given request's mark (never another, newer one) and ends this page's attempt for it. */
export function clearSentStart(runtimeKey: string, directory: string, clientRequestId: string | undefined): void {
  releaseSentStart(clientRequestId);
  if (!clientRequestId || readMarker(runtimeKey, directory)?.clientRequestId !== clientRequestId) return;
  writeMarker(runtimeKey, directory, null);
  if (outcomes.delete(slot(runtimeKey, directory))) notify();
}

/** The person keeps an unresolvable text as an unsent draft (never a dead end). The start itself is left alone. */
export function keepSentTextAsDraft(runtimeKey: string, directory: string): void {
  clearSentStart(runtimeKey, directory, readMarker(runtimeKey, directory)?.clientRequestId);
}

const userText = (parts: readonly { type: string; text?: string }[]) => parts.map(part => (part.type === 'text' ? part.text ?? '' : '')).join('');

/**
 * Read what became of a sent start; see the module comment. `ownRequestId` is this tab's own saved request: the tab
 * continues its own start through Send, so it is not locked. `draftId` is the draft generation whose text a delivered
 * start consumes (the mounted composer's own); a newer draft's text is never touched.
 */
export async function resolveSentStart(runtimeKey: string, directory: string, draftId: number, ownRequestId?: string): Promise<Resolved> {
  const key = slot(runtimeKey, directory), marker = readMarker(runtimeKey, directory);
  const settle = (outcome: Resolved): Resolved => {
    // A newer mark or a kept draft replaced this one meanwhile: that one is resolved on its own.
    if (readMarker(runtimeKey, directory)?.clientRequestId !== marker?.clientRequestId) return outcomes.get(key) ?? null;
    if (marker && outcome === 'stopped') writeMarker(runtimeKey, directory, null);
    if (outcome && outcome !== 'delivered') outcomes.set(key, outcome); else outcomes.delete(key);
    notify();
    return outcome;
  };
  const draft = createChatDraftIdentity(runtimeKey, directory, null, draftId);
  if (marker?.admitted) {
    if (Date.now() - (marker.at ?? 0) > ADMITTED_MS) writeMarker(runtimeKey, directory, null);
    // Handled here before (or sent from here): unrelated to this draft now, so it never blocks a new start.
    if (handled.has(marker.clientRequestId)) return settle(null);
    // Delivered: consume this tab's copy (live editor and saved draft, only if it is that text) once, then unlock.
    handled.add(marker.clientRequestId);
    if (marker.text) consumeChatDraft(draft, marker.text);
    return settle('delivered');
  }
  // No mark, or this tab's own start: it continues it through Send; the mark stays until the start resolves.
  if (!marker || marker.clientRequestId === ownRequestId || sending.has(marker.clientRequestId)) return settle(null);
  const text = readChatDraft(draft).text;
  // No copy of the text here: nothing to guard or consume (the mark is left for a tab that has one).
  if (!text) return settle(null);
  outcomes.set(key, outcomes.get(key) ?? 'resolving'); notify();
  const live = await locks()?.query()
    .then(state => (state.held ?? []).some(lock => lock.name === lockName(marker.clientRequestId)), () => false);
  if (live) return settle('pending');
  const listed = await opencodeClient.listNativeCreations(directory).catch(() => undefined);
  const start = listed?.find(operation => operation.clientRequestId === marker.clientRequestId && operation.directory === directory);
  if (start && STOPPED.includes(start.phase)) return settle('stopped');
  // Still starting: pending. Not readable ('unavailable'), not listed, or no user message: unknown.
  if (start && start.phase !== 'ready' && start.phase !== 'unavailable') return settle('pending');
  const history = start?.native ? await opencodeClient.getSessionMessages(start.native.id, 20, directory).catch(() => undefined) : undefined;
  const sent = history?.filter(record => record.info.role === 'user').map(record => userText(record.parts)) ?? [];
  // Only this draft's own text counts as delivered.
  if (!sent.includes(text)) return settle('unknown');
  if (readMarker(runtimeKey, directory)?.clientRequestId !== marker.clientRequestId) return outcomes.get(key) ?? null;
  // Found delivered: flag the mark admitted with that text, so every other tab consumes its copy too.
  writeMarker(runtimeKey, directory, { clientRequestId: marker.clientRequestId, admitted: true, text, at: Date.now() });
  handled.add(marker.clientRequestId);
  consumeChatDraft(draft, text);
  return settle('delivered');
}

/**
 * This project's sent-start outcome. It resolves when the new-session draft opens there (load or New session) and
 * whenever another tab sets, admits or clears the mark (a tab already open sees a Send made in another one).
 */
export function useSentStart(runtimeKey: string, directory: string | null | undefined, draftId: number,
  ownRequestId: () => string | undefined): SentStartOutcome | null {
  const key = directory ? slot(runtimeKey, directory) : '';
  const own = React.useRef(ownRequestId); own.current = ownRequestId;
  React.useEffect(() => {
    if (!directory) return;
    const resolve = () => { void resolveSentStart(runtimeKey, directory, draftId, own.current()); };
    const changed = (event: StorageEvent) => { if (event.key === storageKey(runtimeKey, directory)) resolve(); };
    // After this commit's other effects: the composer's draft consumer must be listening before a delivered text is
    // consumed (a cold mount with an admitted mark).
    const first = setTimeout(resolve, 0);
    window.addEventListener('storage', changed);
    return () => { clearTimeout(first); window.removeEventListener('storage', changed); };
  }, [directory, draftId, runtimeKey]);
  return React.useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => (key ? outcomes.get(key) ?? null : null), () => null);
}

/** Read-only while the text may already be taking its start: never editable or sendable as an ordinary draft. */
export const sentStartLocks = (outcome: Resolved): boolean =>
  outcome === 'resolving' || outcome === 'pending' || outcome === 'unknown';

/** Tests model a page load. */
export function resetSentStartsForPage(): void {
  for (const release of sending.values()) release();
  sending.clear(); outcomes.clear(); handled.clear(); notify();
}
