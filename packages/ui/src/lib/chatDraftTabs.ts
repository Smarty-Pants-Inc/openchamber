import { z } from 'zod';
import { getSafeSessionStorage, getSafeStorage } from '@/stores/utils/safeStorage';

/**
 * A project's New session draft, saved per browser tab (smarty-code#461): with one shared slot, a second tab's draft
 * overwrote the first's. Design after openchamber#433 round 5 (scope decision: code-lead, 2026-09-30; cut items in
 * smarty-code#1039): the least state that keeps tabs apart.
 * - A tab's id lives in sessionStorage, so it is stable across that tab's reloads and differs between tabs. Its draft is
 *   ONE localStorage key, which only that tab writes or removes.
 * - A fresh tab starts empty. The pre-#461 shared draft is copied once into the first tab that reads it; the caller
 *   removes the shared entry only after that copy is durably stored.
 * Accepted limits (#1039): a fresh tab does not restore another tab's draft; a duplicated tab (which copies
 * sessionStorage) shares the original's slot.
 */
const slotSchema = z.object({ text: z.string(), confirmedMentions: z.array(z.string()), touchedAt: z.number(), since: z.number().optional() });
export type PersistedSlot = z.infer<typeof slotSchema>;
type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): boolean | void; removeItem(key: string): void };
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
  let id: string | undefined;
  /** This tab's id: kept in sessionStorage, so the same across its reloads. */
  function tabId(): string {
    if (id) return id;
    id = session.getItem(TAB_KEY) || newId();
    session.setItem(TAB_KEY, id);
    return id;
  }
  const readSlot = (runtimeKey: string, directory: string) => parseSlot(storage.getItem(slotKey(runtimeKey, directory, tabId())));
  /** True only when backing storage accepted it. An empty draft removes this tab's slot. */
  function writeSlot(runtimeKey: string, directory: string, slot: PersistedSlot | undefined): boolean {
    const key = slotKey(runtimeKey, directory, tabId());
    if (!slot) { storage.removeItem(key); return true; }
    return storage.setItem(key, JSON.stringify(slot)) !== false;
  }
  /** The pre-#461 shared draft, copied into this tab when it has none. `stored`: the copy reached backing storage. */
  function adoptLegacy(runtimeKey: string, directory: string, legacy: PersistedSlot | undefined): { stored: boolean } | false {
    if (!legacy || readSlot(runtimeKey, directory)) return false;
    return { stored: writeSlot(runtimeKey, directory, legacy) };
  }
  return { tabId, readSlot, writeSlot, adoptLegacy,
    newSessionSlotKey: (runtimeKey: string, directory: string) => slotKey(runtimeKey, directory, tabId()) };
}

const drafts = createTabDrafts({ storage: getSafeStorage(), session: getSafeSessionStorage() });
export const { tabId, readSlot, writeSlot, adoptLegacy, newSessionSlotKey } = drafts;

/** Saves this tab's New session draft (an empty one removes it). undefined: nothing to change. */
export function writeTabDraft(runtimeKey: string, directory: string, previous: PersistedSlot | undefined, text: string,
  confirmedMentions: Iterable<string>, since: number | undefined, retry: boolean): boolean | undefined {
  const mentions = Array.from(new Set(confirmedMentions)), now = Date.now();
  if (!text && mentions.length === 0) return previous || retry ? writeSlot(runtimeKey, directory, undefined) : undefined;
  return writeSlot(runtimeKey, directory, { text, confirmedMentions: mentions, touchedAt: now,
    since: since ?? (previous?.text === text ? previous.since ?? previous.touchedAt : now) });
}
