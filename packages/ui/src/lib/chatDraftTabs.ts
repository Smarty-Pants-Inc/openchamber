import { z } from 'zod';
import { getSafeSessionStorage, getSafeStorage } from '@/stores/utils/safeStorage';

/**
 * A project's New session draft, saved per browser tab (smarty-code#461): with one shared slot, a second tab's draft
 * overwrote the first's. Design after openchamber#433 round 5 (scope decision: code-lead, 2026-09-30; cut items in
 * smarty-code#1039): the least state that keeps tabs apart.
 * - A tab's id lives in sessionStorage, so it is stable across that tab's reloads and differs between tabs. Its draft is
 *   ONE localStorage key, which only that tab writes. A save counts as done only when both the draft and the id are
 *   stored; a clear writes an empty draft (a refused write is seen; a refused removal is not).
 * - A fresh tab starts empty. The pre-#461 shared draft is copied once into the first tab that reads it; the caller
 *   removes the shared entry only after that copy is durably stored.
 * Accepted limits (#1039): a fresh tab does not restore another tab's draft; a duplicated tab (which copies
 * sessionStorage) shares the original's slot.
 */
const slotSchema = z.object({ text: z.string(), confirmedMentions: z.array(z.string()), touchedAt: z.number(), since: z.number().optional() });
export type PersistedSlot = z.infer<typeof slotSchema>;
type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): boolean | void };
type Env = { storage: Storage; session: Pick<Storage, 'getItem' | 'setItem'> };

const TAB_KEY = 'openchamber.chatDraftTab';
const SLOT = 'openchamber.chatDraftSlot:';
const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const slotKey = (runtimeKey: string, directory: string, tab: string) => SLOT + JSON.stringify([runtimeKey, directory, tab]);
function parseSlot(raw: string | null): PersistedSlot | undefined {
  if (raw === null) return undefined;
  try { return slotSchema.safeParse(JSON.parse(raw)).data; } catch { return undefined; }
}

/** One page's view of its tab's drafts (tests make several). */
export function createTabDrafts(env: Env) {
  const { storage, session } = env;
  let id: string | undefined, idStored = false;
  /** Saves this tab's id where its next load finds it; false while sessionStorage refuses it (#433 r6 P1 2). */
  // A browser Storage returns undefined; the safe adapters return false when the value stayed in page memory only.
  const stored = (result: boolean | void) => result !== false;
  const storeId = () => (idStored ||= stored(session.setItem(TAB_KEY, id!)));
  /** This tab's id: kept in sessionStorage, so the same across its reloads. */
  function tabId(): string {
    if (id) return id;
    id = session.getItem(TAB_KEY) || newId();
    storeId();
    return id;
  }
  /** This tab's draft; a cleared slot (an empty text: a clear or a consumed send) is no draft. */
  function readSlot(runtimeKey: string, directory: string): PersistedSlot | undefined {
    const key = slotKey(runtimeKey, directory, tabId());
    const slot = parseSlot(unsaved.get(key)?.value ?? storage.getItem(key));
    return slot && (slot.text || slot.confirmedMentions.length) ? slot : undefined;
  }
  /**
   * True only when the draft is reload-safe: backing storage accepted it AND this tab's id is saved (its next load finds
   * the slot). An empty draft is WRITTEN as a cleared slot, not removed: a refused removal is invisible (the adapter hides
   * the old value in page memory only), a refused write is reported (#433 r6 P1 3).
   */
  function writeSlot(runtimeKey: string, directory: string, slot: PersistedSlot | undefined, now = Date.now()): boolean {
    const key = slotKey(runtimeKey, directory, tabId());
    const value = JSON.stringify(slot ?? { text: '', confirmedMentions: [], touchedAt: now });
    const ok = stored(storage.setItem(key, value)) && storeId();
    if (!ok) { unsaved.set(key, { value, legacyKey: JSON.stringify([runtimeKey, directory, null]) }); return false; }
    unsaved.delete(key);
    // The persistence owner retries other keys and durably removes their superseded legacy entries.
    return true;
  }
  /**
   * Writes storage refused, by key, until each one is stored (#433 r7): a clear (or a consumed send) of project P that
   * failed stays owed after the tab moves to project Q, so Q's successful save neither acknowledges P's clear nor
   * forgets it. Each later successful write retries them, and so does a write of P itself, even of an unchanged empty
   * draft. The latest value per key wins.
   */
  const unsaved = new Map<string, { value: string; legacyKey: string }>();
  /** Shared envelope keys superseded by the slots this retry durably stored. */
  function retryUnsaved(): string[] {
    // Envelope saves can retry too: the tab id must also survive a reload.
    const completed: string[] = [];
    if (unsaved.size === 0 || !storeId()) return completed;
    for (const [key, pending] of unsaved) if (stored(storage.setItem(key, pending.value))) {
      unsaved.delete(key);
      completed.push(pending.legacyKey);
    }
    return completed;
  }
  /** Whether this tab's draft of the project has a refused write still owed. */
  const owes = (runtimeKey: string, directory: string) => unsaved.has(slotKey(runtimeKey, directory, tabId()));
  /** The pre-#461 shared draft, copied into this tab when it has none. `stored`: the copy reached backing storage. */
  function adoptLegacy(runtimeKey: string, directory: string, legacy: PersistedSlot | undefined): { stored: boolean } | false {
    const key = slotKey(runtimeKey, directory, tabId());
    // A valid own slot, including a pending or durable empty tombstone, supersedes shared legacy text.
    if (!legacy || unsaved.has(key) || parseSlot(storage.getItem(key))) return false;
    return { stored: writeSlot(runtimeKey, directory, legacy) };
  }
  return { tabId, readSlot, writeSlot, adoptLegacy, owes, retryUnsaved, hasUnsaved: () => unsaved.size > 0,
    newSessionSlotKey: (runtimeKey: string, directory: string) => slotKey(runtimeKey, directory, tabId()) };
}

const drafts = createTabDrafts({ storage: getSafeStorage(), session: getSafeSessionStorage() });
export const { tabId, readSlot, writeSlot, adoptLegacy, newSessionSlotKey, owes, retryUnsaved, hasUnsaved } = drafts;

/** Saves this tab's New session draft (an empty one removes it). undefined: nothing to change. */
export function writeTabDraft(runtimeKey: string, directory: string, previous: PersistedSlot | undefined, text: string,
  confirmedMentions: Iterable<string>, since: number | undefined, retry: boolean): boolean | undefined {
  const mentions = Array.from(new Set(confirmedMentions)), now = Date.now();
  if (!text && mentions.length === 0) return previous || retry || owes(runtimeKey, directory) ? writeSlot(runtimeKey, directory, undefined) : undefined;
  return writeSlot(runtimeKey, directory, { text, confirmedMentions: mentions, touchedAt: now,
    since: since ?? (previous?.text === text ? previous.since ?? previous.touchedAt : now) });
}
