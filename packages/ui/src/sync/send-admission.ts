import { z } from 'zod';
import { getSyncMessages } from './sync-refs';
import { optimisticMessageRecords } from './unsaved';

/**
 * smarty-code#1427: one ordinary (Pi) Send at a time per runtime and session, across the tabs of this browser.
 *
 * - A Send claims the session synchronously in this page, then takes the session's Web Lock for as long as its request
 *   is unresolved. Another tab's Send, or a second Send here, is refused meanwhile ("Waiting for your last message").
 * - Once the request leaves (dispatched), a marker in localStorage names its client message ID and text. A tab closed
 *   mid-request, a reload, or an ambiguous outcome (lost response, 503, client-ID conflict) leaves that marker: the
 *   session stays fenced for every OTHER message, in every tab, until the outcome is known.
 * - The same message, re-sent with its original client ID, is always admitted. The gateway's client-ID reservation
 *   dedupes it, so this is how an unknown outcome gets resolved without risking a duplicate: its answer (accepted or
 *   refused) settles the marker. A confirmed message with that ID in the session's history settles it too.
 * - Known acceptance or refusal clears the marker at once. Clearing never sends anything.
 *
 * Without Web Locks (old webviews, tests) the page-local claim and the marker still apply; only the cross-tab exclusion
 * of two simultaneous first sends is lost.
 */
type SendOutcome = 'refused' | 'unknown';
type SendAttempt = {
  readonly messageID: string;
  /** Takes the cross-tab lock. False: another tab is sending to this session; the attempt is already released. */
  acquire(): Promise<boolean>;
  /** False once a newer claim replaced this one, or the outcome turned unknown. */
  canDispatch(): boolean;
  /** The request is about to leave: from here an ambiguous failure keeps the session fenced. */
  dispatched(): void;
  accepted(): void;
  failed(outcome: SendOutcome): void;
};
/** `inFlight`: this tab's request is still being prepared or awaiting its answer; not even its retry goes yet. */
type UnconfirmedSend = { messageID: string; content: string; inFlight: boolean };

type Phase = 'preparing' | 'dispatched' | 'unknown';
type Claim = { messageID: string; content: string; phase: Phase; unlock: () => void };

const markerSchema = z.object({ messageID: z.string().min(1), content: z.string() });
type Marker = z.infer<typeof markerSchema>;
const key = (runtimeKey: string, sessionId: string) => JSON.stringify([runtimeKey, sessionId]);
const markerKey = (runtimeKey: string, sessionId: string) => `oc.send.unconfirmed:${key(runtimeKey, sessionId)}`;
const lockName = (runtimeKey: string, sessionId: string) => `oc.send.session:${key(runtimeKey, sessionId)}`;
const claims = new Map<string, Claim>();
/** This page's last lock request per session: it settles once the browser has really released the lock. */
const releasing = new Map<string, Promise<unknown>>();
const locks = (): LockManager | undefined => globalThis.navigator?.locks;

function readMarker(runtimeKey: string, sessionId: string): Marker | undefined {
  try {
    const parsed = markerSchema.safeParse(JSON.parse(localStorage.getItem(markerKey(runtimeKey, sessionId)) ?? 'null'));
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}
function writeMarker(runtimeKey: string, sessionId: string, marker: Marker | null) {
  try {
    if (marker) localStorage.setItem(markerKey(runtimeKey, sessionId), JSON.stringify(marker));
    else localStorage.removeItem(markerKey(runtimeKey, sessionId));
  } catch { /* No storage: the page-local claim still fences this tab. */ }
}

/** A confirmed (not optimistic) user message with this client ID in the session's history: it was delivered. */
function delivered(sessionId: string, directory: string | undefined, messageID: string) {
  return getSyncMessages(sessionId, directory).some(message => message.id === messageID && !optimisticMessageRecords.has(message));
}

/** Settles an unknown send whose message now shows in history. */
/** True when localStorage is readable here, so a missing marker means another tab settled the send. */
function storageReadable() {
  try { localStorage.getItem('oc.send.probe'); return true; } catch { return false; }
}

function reconcile(runtimeKey: string, sessionId: string, directory: string | undefined) {
  const id = key(runtimeKey, sessionId), claim = claims.get(id), marker = readMarker(runtimeKey, sessionId);
  if (claim?.phase === 'unknown' && (delivered(sessionId, directory, claim.messageID)
    || (!marker && storageReadable()))) claims.delete(id);
  if (marker && !(claims.get(id) && claims.get(id)?.messageID === marker.messageID && claims.get(id)?.phase !== 'unknown')
    && delivered(sessionId, directory, marker.messageID)) writeMarker(runtimeKey, sessionId, null);
}

export const sendAdmission = {
  /**
   * The send this session is waiting on, from this tab or another: its client ID and text. Undefined when the session
   * takes a new message now. A session waiting only on another tab's in-flight first send (lock held, no marker yet)
   * reads as free here; `begin` and `acquire` still refuse it.
   */
  unconfirmed(runtimeKey: string, sessionId: string, directory?: string): UnconfirmedSend | undefined {
    reconcile(runtimeKey, sessionId, directory);
    const claim = claims.get(key(runtimeKey, sessionId));
    if (claim) return { messageID: claim.messageID, content: claim.content, inFlight: claim.phase !== 'unknown' };
    const marker = readMarker(runtimeKey, sessionId);
    return marker && { ...marker, inFlight: false };
  },

  /**
   * Claims the session for one Send, synchronously. Null when another message to it is unresolved; the same message
   * (its original client ID) is admitted, as its retry.
   */
  begin(runtimeKey: string, sessionId: string, messageID: string, content: string, directory?: string): SendAttempt | null {
    reconcile(runtimeKey, sessionId, directory);
    const id = key(runtimeKey, sessionId), held = claims.get(id), marker = readMarker(runtimeKey, sessionId);
    if (held && !(held.phase === 'unknown' && held.messageID === messageID)) return null;
    if (marker && marker.messageID !== messageID) return null;
    // A retry of an unresolved send: if it fails before leaving, the original is still unresolved.
    const retry = held?.phase === 'unknown' || marker?.messageID === messageID;
    const claim: Claim = { messageID, content, phase: 'preparing', unlock: () => {} };
    claims.set(id, claim);
    const owns = () => claims.get(id) === claim;
    const settle = (keepMarker: boolean) => {
      claim.unlock();
      if (!owns()) return;
      if (keepMarker) { claim.phase = 'unknown'; writeMarker(runtimeKey, sessionId, { messageID, content }); return; }
      claims.delete(id);
      const current = readMarker(runtimeKey, sessionId);
      if (current?.messageID === messageID) writeMarker(runtimeKey, sessionId, null);
    };
    return {
      messageID,
      acquire: async () => {
        const manager = locks();
        if (!manager) return owns();
        const released = new Promise<void>(resolve => { claim.unlock = resolve; });
        // This page's own previous Send may still be letting go of the lock: that is not another tab.
        await releasing.get(id);
        const taken = await new Promise<boolean>(resolve => {
          const request = manager.request(lockName(runtimeKey, sessionId), { ifAvailable: true }, lock => {
            resolve(Boolean(lock));
            return lock ? released : undefined;
          }).catch(() => resolve(false));
          releasing.set(id, request);
        });
        if (!taken || !owns()) {
          // Another tab holds the session. A retry leaves the original unresolved; a first Send leaves nothing behind.
          if (owns()) { if (retry) claim.phase = 'unknown'; else claims.delete(id); }
          claim.unlock();
          return false;
        }
        return true;
      },
      canDispatch: () => owns() && claim.phase !== 'unknown',
      dispatched: () => {
        if (!owns() || claim.phase !== 'preparing') return;
        claim.phase = 'dispatched';
        // From here a closed tab, a reload or a lost response leaves the session fenced for other messages.
        writeMarker(runtimeKey, sessionId, { messageID, content });
      },
      accepted: () => settle(false),
      failed: outcome => {
        if (!owns()) { claim.unlock(); return; }
        settle(claim.phase === 'preparing' ? retry : outcome === 'unknown');
      },
    };
  },
};
