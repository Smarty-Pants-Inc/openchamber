import { getSafeSessionStorage, getSafeStorage } from '@/stores/utils/safeStorage';

/**
 * A project's New session draft, saved per browser tab (smarty-code#461): with one shared slot, a second tab's draft
 * overwrote the first's. Design after openchamber#433 round 3 (scope decision: code-lead, 2026-09-30, cut item in
 * smarty-code#1039). localStorage has no atomic cross-page operation, so this module never needs one:
 * - EVERY page load takes a FRESH id, kept in sessionStorage as "the previous id" for the next load of this tab. No two
 *   pages ever write one key: a duplicated tab (which copies sessionStorage) gets its own copy, never a shared slot.
 * - At load, the page COPIES its previous id's slots into its own. It only reads other keys: it writes and removes only
 *   its own slots (a duplicated tab's original may still be live on the previous id).
 * - A fresh tab (no previous id) copies, per project, the newest New session draft saved by any tab (or the pre-#461
 *   shared draft), read only: the same "a new tab shows the last draft" as before #461.
 * Accepted limits (smarty-code#1039): two tabs opened at the same moment can copy the same draft (a duplicate, never a
 * loss); the slots of closed pages (a reload leaves its previous id's slot) are not removed yet.
 */
export type PersistedSlot = { text: string; confirmedMentions: string[]; touchedAt: number; since?: number };
type Env = {
  storage: Pick<Storage, 'getItem' | 'removeItem' | 'key' | 'length'> & { setItem: (key: string, value: string) => boolean | void };
  session: Pick<Storage, 'getItem' | 'setItem'>;
};

const TAB_KEY = 'openchamber.chatDraftTab';
const SLOT = 'openchamber.chatDraftSlot:';
const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const slotKey = (runtimeKey: string, directory: string, tab: string) => SLOT + JSON.stringify([runtimeKey, directory, tab]);
const parse = (raw: string | null): PersistedSlot | undefined => {
  try {
    const slot = JSON.parse(raw ?? '') as Partial<PersistedSlot>;
    return typeof slot.text === 'string' && Array.isArray(slot.confirmedMentions) && typeof slot.touchedAt === 'number'
      ? slot as PersistedSlot : undefined;
  } catch { return undefined; }
};

/** One page's view of the per-tab drafts (a module instance is one page; tests make several). */
export function createTabDrafts(env: Env) {
  const { storage, session } = env;
  let id: string | undefined, previous: string | null = null;
  const adopted = new Set<string>(); // Projects this fresh tab already copied a draft into (once each).
  const put = (key: string, value: string) => (storage.setItem(key, value) as boolean | void) !== false;
  const slots = () => {
    const found: { key: string; runtimeKey: string; directory: string; tab: string; slot: PersistedSlot }[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(SLOT)) continue;
      try {
        const [runtimeKey, directory, tab] = JSON.parse(key.slice(SLOT.length)) as [string, string, string];
        const slot = parse(storage.getItem(key)); if (slot) found.push({ key, runtimeKey, directory, tab, slot });
      } catch { /* not ours */ }
    }
    return found;
  };

  /** This page's id: new at every load; its previous id's drafts are copied into it once. */
  function tabId(): string {
    if (id) return id;
    previous = session.getItem(TAB_KEY);
    id = newId();
    session.setItem(TAB_KEY, id);
    // Copy (read only): a duplicated tab's original may still be live on `previous`, so its slot is never removed here.
    if (previous) for (const s of slots()) if (s.tab === previous) put(slotKey(s.runtimeKey, s.directory, id), JSON.stringify(s.slot));
    return id;
  }

  const readSlot = (runtimeKey: string, directory: string): PersistedSlot | undefined =>
    parse(storage.getItem(slotKey(runtimeKey, directory, tabId())));
  /** True only when backing storage accepted it. An empty draft removes this page's slot. */
  const writeSlot = (runtimeKey: string, directory: string, slot: PersistedSlot | undefined): boolean => {
    const key = slotKey(runtimeKey, directory, tabId());
    if (!slot) { storage.removeItem(key); return true; }
    return put(key, JSON.stringify(slot));
  };

  /**
   * A FRESH tab (no previous id) with no draft of its own in this project copies, once, the newest New session draft
   * of any tab in the project, or the given pre-#461 shared draft if that is newer. Nothing else is written or removed.
   * `stored`: the copy reached backing storage (the caller may then remove the pre-#461 entry it came from).
   */
  function adoptNewest(runtimeKey: string, directory: string, legacy?: PersistedSlot): { from: 'tab' | 'legacy'; stored: boolean } | false {
    const mine = tabId(), project = JSON.stringify([runtimeKey, directory]);
    if (previous !== null || adopted.has(project) || readSlot(runtimeKey, directory)) return false;
    adopted.add(project);
    const newest = slots().filter(s => s.runtimeKey === runtimeKey && s.directory === directory && s.tab !== mine)
      .sort((left, right) => right.slot.touchedAt - left.slot.touchedAt)[0]?.slot;
    const source = newest && (!legacy || newest.touchedAt >= legacy.touchedAt) ? newest : legacy;
    if (!source) return false;
    return { from: source === legacy ? 'legacy' : 'tab', stored: writeSlot(runtimeKey, directory, source) };
  }

  return { tabId, readSlot, writeSlot, adoptNewest,
    newSessionSlotKey: (runtimeKey: string, directory: string) => slotKey(runtimeKey, directory, tabId()) };
}

const drafts = createTabDrafts({ storage: getSafeStorage() as unknown as Env['storage'], session: getSafeSessionStorage() });
export const { tabId, readSlot, writeSlot, adoptNewest, newSessionSlotKey } = drafts;

/** Saves this tab's New session draft (an empty one removes it). undefined: nothing to change. */
export function writeTabDraft(runtimeKey: string, directory: string, previous: PersistedSlot | undefined, text: string,
  confirmedMentions: Iterable<string>, since: number | undefined, retry: boolean): boolean | undefined {
  const mentions = Array.from(new Set(confirmedMentions)), now = Date.now();
  if (!text && mentions.length === 0) return previous || retry ? writeSlot(runtimeKey, directory, undefined) : undefined;
  return writeSlot(runtimeKey, directory, { text, confirmedMentions: mentions, touchedAt: now,
    since: since ?? (previous?.text === text ? previous.since ?? previous.touchedAt : now) });
}
