import { getSafeSessionStorage, getSafeStorage } from '@/stores/utils/safeStorage';

/**
 * A project's New session draft, saved per browser tab (smarty-code#461): with one shared slot, a second tab's draft
 * overwrote the first's. openchamber#433 review 1 rules this module follows:
 * - Each tab's slot is its OWN localStorage key, so two tabs writing at once never rewrite (and drop) each other's.
 * - A tab's id lives in sessionStorage (stable across its reloads) and is CLAIMED by the page using it; the claim is
 *   released only when the page goes away (pagehide). A page that finds its id claimed by another live page (a
 *   duplicated tab, or one opened with an opener: both copy sessionStorage) takes a new id and starts from a copy.
 * - A closed tab's draft (its claim released) is COPIED once into a new tab that has none; it is never deleted, so a
 *   tab that was only frozen or suspended (its claim still held, whatever its timers did) never loses its text.
 */
export type PersistedSlot = { text: string; confirmedMentions: string[]; touchedAt: number; since?: number; adoptedBy?: string };

const TAB_KEY = 'openchamber.chatDraftTab';
const CLAIM = 'openchamber.chatDraftTabClaim:';
const SLOT = 'openchamber.chatDraftSlot:';
const ADOPTED_KEEP_MS = 7 * 24 * 3_600_000;
const storage = getSafeStorage();
const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const page = newId(); // This page instance: its claims name it.
let current: string | undefined;

const slotKey = (runtimeKey: string, directory: string, tab: string) => SLOT + JSON.stringify([runtimeKey, directory, tab]);
const parse = (raw: string | null): PersistedSlot | undefined => {
  try {
    const slot = JSON.parse(raw ?? '') as Partial<PersistedSlot>;
    return typeof slot.text === 'string' && Array.isArray(slot.confirmedMentions) && typeof slot.touchedAt === 'number'
      ? slot as PersistedSlot : undefined;
  } catch { return undefined; }
};
/** Every saved tab slot: its key, runtime, directory, tab and draft. */
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

const claim = (id: string) => storage.setItem(CLAIM + id, page);
let released = false;
const listen = () => {
  if (released || typeof window === 'undefined') return;
  released = true;
  window.addEventListener('pagehide', () => { if (current && storage.getItem(CLAIM + current) === page) storage.removeItem(CLAIM + current); });
  window.addEventListener('pageshow', (event) => { if ((event as PageTransitionEvent).persisted && current) claim(current); });
};

/** This tab's id: its own across reloads, never shared with another live tab. */
export function tabId(): string {
  const session = getSafeSessionStorage();
  let id = session.getItem(TAB_KEY);
  if (id && id === current && storage.getItem(CLAIM + id) === page) return id;
  if (id && id !== current) {
    const holder = storage.getItem(CLAIM + id);
    if (holder && holder !== page) { // Another live page uses it: a duplicate. Start from a copy of its drafts.
      const original = id; id = newId();
      for (const s of slots()) if (s.tab === original) storage.setItem(slotKey(s.runtimeKey, s.directory, id), JSON.stringify({ ...s.slot, adoptedBy: undefined }));
    }
  } else if (!id) id = newId();
  session.setItem(TAB_KEY, id); claim(id); current = id; listen();
  return id;
}

/** Where this tab's New session draft of a project is stored (tests read it directly). */
export const newSessionSlotKey = (runtimeKey: string, directory: string) => slotKey(runtimeKey, directory, tabId());
export const readSlot = (runtimeKey: string, directory: string): PersistedSlot | undefined =>
  parse(storage.getItem(slotKey(runtimeKey, directory, tabId())));
/** True: backing storage accepted it. An empty draft removes the slot. */
export const writeSlot = (runtimeKey: string, directory: string, slot: PersistedSlot | undefined): boolean => {
  const key = slotKey(runtimeKey, directory, tabId());
  if (!slot) { storage.removeItem(key); return true; }
  return storage.setItem(key, JSON.stringify(slot));
};

/** Saves this tab's New session draft (an empty one removes it). undefined: nothing to change. */
export function writeTabDraft(runtimeKey: string, directory: string, previous: PersistedSlot | undefined, text: string,
  confirmedMentions: Iterable<string>, since: number | undefined, retry: boolean): boolean | undefined {
  const mentions = Array.from(new Set(confirmedMentions)), now = Date.now();
  if (!text && mentions.length === 0) return previous || retry ? writeSlot(runtimeKey, directory, undefined) : undefined;
  return writeSlot(runtimeKey, directory, { text, confirmedMentions: mentions, touchedAt: now,
    since: since ?? (previous?.text === text ? previous.since ?? previous.touchedAt : now) });
}

/**
 * A tab with no New session draft of its own copies, once, the newest draft of a CLOSED tab (its claim released) in the
 * same project, or the given pre-#461 shared draft. The original stays (marked adopted, pruned after a week).
 */
export function adoptOrphan(runtimeKey: string, directory: string, legacy?: PersistedSlot): 'orphan' | 'legacy' | false {
  const mine = tabId();
  if (readSlot(runtimeKey, directory)) return false;
  const now = Date.now();
  const candidates = slots().filter(s => s.runtimeKey === runtimeKey && s.directory === directory && s.tab !== mine);
  for (const s of candidates) if (s.slot.adoptedBy && now - s.slot.touchedAt > ADOPTED_KEEP_MS) storage.removeItem(s.key);
  const orphan = candidates.filter(s => !s.slot.adoptedBy && storage.getItem(CLAIM + s.tab) === null)
    .sort((left, right) => right.slot.touchedAt - left.slot.touchedAt)[0];
  const source = orphan?.slot ?? legacy;
  if (!source) return false;
  writeSlot(runtimeKey, directory, { ...source, adoptedBy: undefined });
  if (orphan) storage.setItem(orphan.key, JSON.stringify({ ...orphan.slot, adoptedBy: mine }));
  return orphan ? 'orphan' : 'legacy';
}
