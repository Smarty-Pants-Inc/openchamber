import React from 'react';
import { consumeChatDraft, createChatDraftIdentity, readChatDraft, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { tabId } from '@/lib/chatDraftTabs';
import { opencodeClient } from '@/lib/opencode/client';
import type { NativeCreationState } from '@/lib/opencode/nativeCreation';
import { z } from 'zod';

const markerSchema = z.object({ clientRequestId: z.string().min(1), admitted: z.literal(true).optional(),
  // New session drafts belong to a tab lineage. Missing on legacy marks; never evidence of shared text ownership.
  tabId: z.string().min(1).optional(),
  // Its start's operation: read directly once the listing no longer shows it (a settled start leaves the listing after
  // 5 min), so a start that expired is found stopped, never left 'unknown' (#117, code-controls on 3.36).
  operationId: z.string().optional(),
  text: z.string().optional(), at: z.number().optional(),
  // The text a Send submitted and when, recorded before its prompt POST: a lost reply's recovery settles exactly that
  // submission, never a draft set after it (#220).
  submittedText: z.string().optional(), submittedAt: z.number().optional() });

/**
 * A Send whose session start the server accepted (202, its client request id echoed) owns the new-session draft's
 * text until that start resolves (#117, closed tab). The mark is in localStorage, so every tab sees it. Resolving it only
 * reads the start and its session's history, never answers or continues it.
 * - While a tab is in its Send attempt for that request, it holds a Web Lock named after the request: other tabs show
 *   the text as pending (read-only, no way to edit it).
 * - An admitted (or found delivered) Send keeps the mark, flagged admitted with its text, for ADMITTED_MS. Only the
 *   sender's tab lineage (including duplicates sharing its tab id) consumes through its own draft generation.
 *   Independent tabs never consume, even with equal text. Nothing but a stopped start removes a mark early.
 * - Legacy marks without a tab id still coordinate unresolved starts, but never consume text. An explicit Send that
 *   continues its own saved request adds its lineage before dispatch; history recovery cannot infer one.
 * - Only a stopped start (expired, denied, cancelled) proves the text was not sent: it is restored as unsent, and the
 *   outcome names why. Anything
 *   else not proven (no user message yet, no live sender, not readable) is unknown: read-only until the person
 *   explicitly edits it as an unsent message.
 */
/** A stopped start's outcome is its phase, so the person is told why (it expired, was declined or was cancelled). */
export type SentStartStopped = 'expired' | 'denied' | 'cancelled';
export type SentStartOutcome = 'resolving' | 'pending' | 'unknown' | SentStartStopped;
type Marker = z.infer<typeof markerSchema>;
type Resolved = SentStartOutcome | 'delivered' | null;

const STOPPED: readonly string[] = ['denied', 'cancelled', 'expired'] satisfies SentStartStopped[];
export const isSentStartStopped = (outcome: unknown): outcome is SentStartStopped => STOPPED.includes(outcome as string);
const slot = (runtimeKey: string, directory: string) => JSON.stringify([runtimeKey, directory]);
const storageKey = (runtimeKey: string, directory: string) => `oc.nativeCreation.sent:${slot(runtimeKey, directory)}`;
const lockName = (id: string) => `oc.nativeCreation.sending:${id}`;
const ADMITTED_MS = 600_000;
/** Admitted marks this page already consumed from (or sent itself): a later draft with the same text is never touched. */
const handled = new Set<string>();
const outcomes = new Map<string, SentStartOutcome>();
/** Who stopped the start a slot's text was sent to, when its gateway says (smarty-code#523). */
const stoppers = new Map<string, { name: string; subject?: string }>();
export const sentStartStoppedBy = (runtimeKey: string, directory: string): string | undefined => stoppers.get(slot(runtimeKey, directory))?.name;
/** smarty-code#849: the stopper's account subject, to tell "you" from another person. */
export const sentStartStopperSubject = (runtimeKey: string, directory: string): string | undefined => stoppers.get(slot(runtimeKey, directory))?.subject;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
/** The requests this page is sending (its locks), by request id. */
const sending = new Map<string, { release: () => void; request: Promise<unknown> }>();

const parseMarker = (raw: string | null): Marker | undefined => {
  try {
    const parsed = markerSchema.safeParse(JSON.parse(raw ?? 'null'));
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
};
const readMarker = (runtimeKey: string, directory: string): Marker | undefined => {
  try { return parseMarker(localStorage.getItem(storageKey(runtimeKey, directory))); } catch { return undefined; }
};
/** False when the browser refused to store it (no storage, or full). */
const writeMarker = (runtimeKey: string, directory: string, marker: Marker | null): boolean => {
  try {
    if (marker) localStorage.setItem(storageKey(runtimeKey, directory), JSON.stringify(marker));
    else localStorage.removeItem(storageKey(runtimeKey, directory));
    return true;
  } catch { return false; }
};
const locks = (): LockManager | undefined => globalThis.navigator?.locks;

/** This page is in a Send attempt for the request: hold its lock until releaseSentStart. */
export function holdSentStart(clientRequestId: string): void {
  if (sending.has(clientRequestId)) return;
  let release = () => {};
  const done = new Promise<void>(resolve => { release = resolve; });
  // The request's own promise settles only once the browser has released the lock (not when `done` resolves): kept,
  // so a release can be awaited before the lock is read again (smarty-code#523, openchamber#357 review 1).
  const request = locks()?.request(lockName(clientRequestId), () => done).catch(() => undefined) ?? Promise.resolve();
  sending.set(clientRequestId, { release, request });
}

/**
 * This page's Send attempt for the request ended (admitted, refused, stopped or given up). The mark stays. The returned
 * promise settles when the browser has actually released the lock (callers that read the lock next must await it).
 */
export function releaseSentStart(clientRequestId: string | undefined): Promise<void> {
  if (!clientRequestId) return Promise.resolve();
  const held = sending.get(clientRequestId);
  held?.release();
  sending.delete(clientRequestId);
  return held ? held.request.then(() => undefined, () => undefined) : Promise.resolve();
}

/** The start for this Send was accepted: its text is sent, not an ordinary draft, until the start resolves. */
export function markSentStart(runtimeKey: string, directory: string, clientRequestId: string, operationId?: string): boolean {
  holdSentStart(clientRequestId);
  const marker: Marker = { clientRequestId, tabId: tabId() };
  if (operationId) marker.operationId = operationId;
  return writeMarker(runtimeKey, directory, marker);
}

/**
 * Before any text goes to an accepted start (its prompt POST, a recovered start), its durable mark must exist, so a
 * page closed after the prompt is admitted leaves the text sent, not an ordinary draft (#117). Its own mark (maybe
 * admitted) is kept; another request's unadmitted mark (a live start) is never replaced ('elsewhere'); a mark the
 * browser refuses to store is 'storage'. Either way nothing may be sent. It takes no lock (the caller holds one).
 */
export function ensureSentStart(runtimeKey: string, directory: string, clientRequestId: string,
  submission?: { text: string; at: number }, operationId?: string): 'marked' | 'elsewhere' | 'storage' {
  const existing = readMarker(runtimeKey, directory);
  const record: Marker = { clientRequestId, tabId: existing?.clientRequestId === clientRequestId ? existing.tabId ?? tabId() : tabId() };
  if (submission) { record.submittedText = submission.text; record.submittedAt = submission.at; }
  if (operationId) record.operationId = operationId;
  if (existing?.clientRequestId === clientRequestId) {
    // The submission this POST carries (a retry may carry another), and its start's operation (a recovered start's
    // mark gains it): durable before it goes.
    const known = !submission || (existing.submittedText === submission.text && existing.submittedAt === submission.at);
    if (existing.admitted || (existing.tabId && known && (!operationId || existing.operationId === operationId))) return 'marked';
    // Only explicit continuation of this exact request can give a legacy unresolved mark a sender lineage.
    return writeMarker(runtimeKey, directory, { ...existing, ...record }) ? 'marked' : 'storage';
  }
  if (existing && !existing.admitted) return 'elsewhere';
  return writeMarker(runtimeKey, directory, record) ? 'marked' : 'storage';
}

/**
 * This request's Send was admitted with its submitted text: same-lineage duplicates consume their copies.
 */
export function admitSentStart(runtimeKey: string, directory: string, clientRequestId: string | undefined, submitted?: string,
  submittedAt = Date.now()): void {
  releaseSentStart(clientRequestId);
  const marker = readMarker(runtimeKey, directory);
  if (clientRequestId && marker?.clientRequestId === clientRequestId) {
    handled.add(clientRequestId);
    // Admitted as of its submission: a copy set after that is a new message, even if its response came later.
    const admitted: Marker = { ...marker, admitted: true, at: submittedAt };
    if (submitted !== undefined) admitted.text = submitted;
    writeMarker(runtimeKey, directory, admitted);
  }
}

/** Clears only the given request's mark (never another, newer one) and ends this page's attempt for it. */
export function clearSentStart(runtimeKey: string, directory: string, clientRequestId: string | undefined): void {
  releaseSentStart(clientRequestId);
  if (!clientRequestId || readMarker(runtimeKey, directory)?.clientRequestId !== clientRequestId) return;
  writeMarker(runtimeKey, directory, null);
  if (outcomes.delete(slot(runtimeKey, directory))) notify();
}

/**
 * The person keeps an unresolvable text as an unsent draft (never a dead end). The start itself is left alone. A tab
 * sending that request now (its lock held, taken after this notice showed) keeps its mark: the text shows pending.
 */
export async function keepSentTextAsDraft(runtimeKey: string, directory: string): Promise<void> {
  const id = readMarker(runtimeKey, directory)?.clientRequestId;
  if (!id) return;
  const manager = locks();
  // Cleared only while it is still that request's unadmitted mark: one admitted meanwhile (its Send delivered the
  // text) stays, and its storage event consumes this copy.
  const clear = () => {
    const now = readMarker(runtimeKey, directory);
    if (now?.clientRequestId === id && !now.admitted) clearSentStart(runtimeKey, directory, id);
  };
  // ifAvailable: taken only when no sender holds it; the mark is cleared while this page holds it.
  const kept = manager ? await manager.request(lockName(id), { ifAvailable: true }, lock => {
    if (lock) clear();
    return lock !== null;
  }).catch(() => false) : (clear(), true);
  if (!kept) { outcomes.set(slot(runtimeKey, directory), 'pending'); notify(); }
}

/**
 * A delivered text is consumed only from a copy that existed when its Send was admitted: a draft saved later (New
 * session, then the same words typed again, even across a reload) is a new message and stays (#220 review).
 */
/** False when this draft generation no longer owns the slot (New session took it): nothing was settled. */
const ownsSentText = (marker: Marker): boolean => marker.tabId === tabId();
const consumeDelivered = (draft: ChatDraftIdentity | null, marker: Marker): boolean =>
  ownsSentText(marker) && (!marker.text || consumeChatDraft(draft, marker.text, marker.at ?? 0));

const userText = (parts: readonly { type: string; text?: string }[]) => parts.map(part => (part.type === 'text' ? part.text ?? '' : '')).join('');

/**
 * Read what became of a sent start; see the module comment. `ownRequestId` is this tab's own saved request: the tab
 * continues its own start through Send, so it is not locked. `draftId` is the draft generation whose text a delivered
 * start consumes (the mounted composer's own); a newer draft's text is never touched.
 */
export async function resolveSentStart(runtimeKey: string, directory: string, draftId: number, ownRequestId?: string): Promise<Resolved> {
  const key = slot(runtimeKey, directory);
  // Copies that existed when this read began are the ones it may find delivered; a draft saved later is newer (#220).
  const began = Date.now();
  let marker = readMarker(runtimeKey, directory);
  // The mark changed meanwhile (a newer one, a kept draft, or this one admitted by another tab): the read that the
  // change started resolves it; this older one never overrides that (it could relock an admitted text).
  const superseded = () => JSON.stringify(readMarker(runtimeKey, directory) ?? null) !== JSON.stringify(marker ?? null);
  const settle = (outcome: Resolved): Resolved => {
    if (superseded()) return outcomes.get(key) ?? null;
    if (marker && isSentStartStopped(outcome)) writeMarker(runtimeKey, directory, null);
    if (outcome && outcome !== 'delivered') outcomes.set(key, outcome); else outcomes.delete(key);
    notify();
    return outcome;
  };
  const draft = createChatDraftIdentity(runtimeKey, directory, null, draftId);
  // An expired admitted mark is no mark: a later draft with the same text is a new message, never consumed.
  if (marker?.admitted && Date.now() - (marker.at ?? 0) > ADMITTED_MS) { writeMarker(runtimeKey, directory, null); marker = undefined; }
  if (marker?.admitted) {
    // Project-wide admission is not draft ownership. Foreign and legacy marks unlock without consuming this text.
    if (!ownsSentText(marker)) return settle(null);
    // Handled here before (or sent from here): unrelated to this draft now, so it never blocks a new start.
    if (handled.has(marker.clientRequestId)) return settle(null);
    // Delivered: consume this lineage's copy (live editor and saved draft, only if it is that text) once. Only a
    // consumption this draft's owner accepted settles it; otherwise the current owner's read settles it.
    if (!consumeDelivered(draft, marker)) return outcomes.get(key) ?? null;
    handled.add(marker.clientRequestId);
    return settle('delivered');
  }
  // No mark, or this tab's own start: it continues it through Send; the mark stays until the start resolves.
  if (!marker || marker.clientRequestId === ownRequestId || sending.has(marker.clientRequestId)) return settle(null);
  const id = marker.clientRequestId;
  const text = readChatDraft(draft).text;
  // No copy of the text here: nothing to guard or consume (the mark is left for a tab that has one).
  if (!text) return settle(null);
  outcomes.set(key, outcomes.get(key) ?? 'resolving'); notify();
  const live = await locks()?.query()
    .then(state => (state.held ?? []).some(lock => lock.name === lockName(id)), () => false);
  if (live) return settle('pending');
  const listed = await opencodeClient.listNativeCreations(directory).catch(() => undefined);
  const own = (operation: NativeCreationState | undefined) => operation?.clientRequestId === id && operation.directory === directory;
  let start = listed?.find(own);
  // Settled starts leave the listing after a while: read its own operation, when the mark knows it.
  if (!start && marker.operationId) {
    const read = await opencodeClient.readNativeCreation(directory, marker.operationId).catch(() => undefined);
    if (own(read)) start = read;
  }
  if (start && isSentStartStopped(start.phase)) {
    // Who stopped it is committed with the outcome, under the same check: a late read never names someone else.
    if (superseded()) return outcomes.get(key) ?? null;
    if (start.stoppedBy?.name) stoppers.set(key, { name: start.stoppedBy.name, subject: start.stoppedBy.subject }); else stoppers.delete(key);
    return settle(start.phase);
  }
  // Still starting: pending. Not readable ('unavailable'), not listed, or no user message: unknown.
  if (start && start.phase !== 'ready' && start.phase !== 'unavailable') return settle('pending');
  const history = start?.native ? await opencodeClient.getSessionMessages(start.native.id, 20, directory).catch(() => undefined) : undefined;
  const sent = history?.filter(record => record.info.role === 'user').map(record => userText(record.parts)) ?? [];
  // What was sent, and when: the Send's own durable record; a mark from before it existed falls back to this draft's
  // text as of this read.
  const delivered = marker.submittedText ?? text, cutoff = marker.submittedAt ?? began;
  if (!sent.includes(delivered)) return settle('unknown');
  if (superseded()) return outcomes.get(key) ?? null;
  // Settle this draft's copy first: only a consumption its current owner accepted commits the recovery (New session
  // may have taken the slot meanwhile; its own read then settles it). A draft set after the submission is kept.
  const sameLineage = ownsSentText(marker);
  if (sameLineage && !consumeChatDraft(draft, delivered, cutoff)) return outcomes.get(key) ?? null;
  // Found delivered: preserve its provenance. Only the sender lineage may consume; project-wide pending ends.
  writeMarker(runtimeKey, directory, { ...marker, admitted: true, text: delivered, at: cutoff });
  marker = readMarker(runtimeKey, directory);
  handled.add(id);
  return settle(sameLineage ? 'delivered' : null);
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
    const changed = (event: StorageEvent) => {
      if (event.key !== storageKey(runtimeKey, directory)) return;
      // Each admission event carries its own delivered text: a later one (the next Send in this project, before this
      // tab handled the first) must not hide it. Consume it once, then resolve the current mark.
      const admitted = parseMarker(event.newValue);
      if (admitted?.admitted && admitted.text && ownsSentText(admitted) && !handled.has(admitted.clientRequestId)
        && Date.now() - (admitted.at ?? 0) <= ADMITTED_MS
        && consumeDelivered(createChatDraftIdentity(runtimeKey, directory, null, draftId), admitted)) {
        handled.add(admitted.clientRequestId);
      }
      resolve();
    };
    // After this commit's other effects: the composer's draft consumer must be listening before a delivered text is
    // consumed (a cold mount with an admitted mark).
    const first = setTimeout(resolve, 0);
    window.addEventListener('storage', changed);
    return () => { clearTimeout(first); window.removeEventListener('storage', changed); };
  }, [directory, draftId, runtimeKey]);
  return React.useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => (key ? outcomes.get(key) ?? null : null), () => null);
}

/** The start request whose text this project's draft holds as sent, if any (smarty-code#523: it can be stopped). */
export const sentStartRequest = (runtimeKey: string, directory: string): string | undefined => readMarker(runtimeKey, directory)?.clientRequestId;

/** Read-only while the text may already be taking its start: never editable or sendable as an ordinary draft. */
export const sentStartLocks = (outcome: Resolved): boolean =>
  outcome === 'resolving' || outcome === 'pending' || outcome === 'unknown';

/** Tests model a page load. */
export function resetSentStartsForPage(): void {
  for (const held of sending.values()) held.release();
  sending.clear(); outcomes.clear(); handled.clear(); stoppers.clear(); notify();
}
