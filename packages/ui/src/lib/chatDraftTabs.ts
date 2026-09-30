import { getSafeSessionStorage, getSafeStorage } from '@/stores/utils/safeStorage';

/**
 * A project's New session draft, saved per browser tab (smarty-code#461): with one shared slot, a second tab's draft
 * overwrote the first's. openchamber#433 reviews 1-2:
 * - Each tab's slot is its OWN localStorage key; this module never writes another tab's key (only its own slots, its
 *   own claim, and markers keyed by itself).
 * - A tab's id lives in sessionStorage (stable across its reloads). Ownership of an id is EXCLUSIVE: the page holds a
 *   Web Lock named by it for its lifetime (released by the browser when the page goes, even on a crash). A page whose
 *   lock is refused (a duplicated tab, or two copies loading at once) takes a new id. Until the lock is granted, its
 *   saves wait in memory, so a loser never writes the winner's slot. Without Web Locks, the claim key below decides:
 *   a page that ever finds another page's claim on its id moves to a new id.
 * - The claim key (openchamber.chatDraftTabClaim:<id>) marks a tab as open; it is released on pagehide AFTER nothing can
 *   re-claim it (a leaving page never claims), and taken again on a back/forward-cache return.
 * - A closed tab's newest draft (claim released) is COPIED once into a new tab that has none. The original is never
 *   rewritten; a marker in the adopter's own key records the copy, and the original is pruned only when it is
 *   unchanged since that copy, its tab is not open, and the copy is a week old.
 * - A migration or a copy is committed (the old entry removed, the marker written) only after the new slot was stored.
 */
export type PersistedSlot = { text: string; confirmedMentions: string[]; touchedAt: number; since?: number; adoptedBy?: string };
type LockManagerLike = { request: (name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<void> | void) => Promise<unknown> };
type Env = {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'> & { setItem: (key: string, value: string) => boolean | void };
  session: Pick<Storage, 'getItem' | 'setItem'>;
  locks?: LockManagerLike | null;
  window?: Pick<Window, 'addEventListener'> | null;
  now?: () => number;
};

const TAB_KEY = 'openchamber.chatDraftTab';
const CLAIM = 'openchamber.chatDraftTabClaim:';
const SLOT = 'openchamber.chatDraftSlot:';
const ADOPTED = 'openchamber.chatDraftAdopted:';
export const ADOPTED_KEEP_MS = 7 * 24 * 3_600_000;
const LOCK_WAIT_MS = 500;
const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const slotKey = (runtimeKey: string, directory: string, tab: string) => SLOT + JSON.stringify([runtimeKey, directory, tab]);
const parse = (raw: string | null): PersistedSlot | undefined => {
  try {
    const slot = JSON.parse(raw ?? '') as Partial<PersistedSlot>;
    return typeof slot.text === 'string' && Array.isArray(slot.confirmedMentions) && typeof slot.touchedAt === 'number'
      ? slot as PersistedSlot : undefined;
  } catch { return undefined; }
};

/** One page's view of the per-tab drafts (a module instance is one page; tests make two). */
export function createTabDrafts(env: Env) {
  const { storage, session } = env, now = env.now ?? Date.now;
  const page = newId(); // This page instance: its claims name it.
  let current: string | undefined, leaving = false, listening = false;
  /** The lock state of `current`: granted (exclusive), pending (asked), or none (no Web Locks: claims decide). */
  let lock: 'granted' | 'pending' | 'none' = env.locks ? 'pending' : 'none';
  /** Saves made before the lock was granted: written to the final id once it is (a loser never writes the winner's). */
  const pending = new Map<string, PersistedSlot | undefined>();
  let onFailure: (() => void) | undefined;
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

  /** Moves this page to a new id, starting from a copy of the old id's drafts (the other page keeps the old id). */
  const leave = (original: string) => {
    const id = newId();
    for (const s of slots()) if (s.tab === original) put(slotKey(s.runtimeKey, s.directory, id), JSON.stringify({ ...s.slot, adoptedBy: undefined }));
    session.setItem(TAB_KEY, id); current = id; put(CLAIM + id, page);
    return id;
  };
  /** Writes the saves that waited for the lock into the final id's slots. */
  const flush = () => {
    for (const [key, slot] of pending) {
      const [runtimeKey, directory] = JSON.parse(key) as [string, string];
      const target = slotKey(runtimeKey, directory, current!);
      if (!slot) storage.removeItem(target); else if (!put(target, JSON.stringify(slot))) onFailure?.();
    }
    pending.clear();
  };
  const ask = (id: string) => {
    lock = 'pending';
    // A lock manager that never answers (some embedded browsers; happy-dom) must not hold saves forever: after a short
    // wait the claim key decides instead, as without Web Locks.
    const fallback = setTimeout(() => { if (current === id && lock === 'pending') { lock = 'none'; flush(); } }, LOCK_WAIT_MS);
    void env.locks!.request(`openchamber.chatDraftTab:${id}`, { ifAvailable: true }, (granted) => {
      clearTimeout(fallback);
      if (current !== id) return;
      if (!granted) { // Another page holds this id: it is a duplicate's. Take a new one, then ask for it.
        leave(id); ask(current!); return;
      }
      lock = 'granted'; flush();
      return new Promise<void>(() => {}); // Held for this page's lifetime; the browser releases it when the page goes.
    }).catch(() => { if (current === id) { lock = 'none'; flush(); } });
  };
  const listen = () => {
    if (listening || !env.window) return;
    listening = true;
    // Registered on first use; a composer flush may run before or after this listener: `leaving` stops any re-claim.
    env.window.addEventListener('pagehide', () => {
      leaving = true;
      if (current && storage.getItem(CLAIM + current) === page) storage.removeItem(CLAIM + current);
    });
    env.window.addEventListener('pageshow', (event) => {
      if (!(event as PageTransitionEvent).persisted || !current) return;
      leaving = false; put(CLAIM + current, page);
    });
  };

  /** This tab's id: its own across reloads, never shared with another live page. */
  function tabId(): string {
    if (leaving && current) return current; // A leaving page reads its own id and never claims it again.
    let id = session.getItem(TAB_KEY);
    if (id && id === current) {
      const holder = storage.getItem(CLAIM + id);
      if (holder === page) return id;
      // Another page claimed this id since (both loaded it from a copied sessionStorage): without an exclusive lock,
      // the page that finds the other's claim moves; with the lock, the lock decides and the claim is only restored.
      if (holder && lock === 'none') return leave(id);
      put(CLAIM + id, page); return id;
    }
    if (id) {
      const holder = storage.getItem(CLAIM + id);
      if (holder && holder !== page && !env.locks) { current = id; return leave(id); } // A duplicate (no Web Locks).
    } else id = newId();
    session.setItem(TAB_KEY, id); current = id; put(CLAIM + id, page); listen();
    if (env.locks) ask(id);
    return id;
  }

  const pendingKey = (runtimeKey: string, directory: string) => JSON.stringify([runtimeKey, directory]);
  const readSlot = (runtimeKey: string, directory: string): PersistedSlot | undefined => {
    const id = tabId(), key = pendingKey(runtimeKey, directory);
    return pending.has(key) ? pending.get(key) : parse(storage.getItem(slotKey(runtimeKey, directory, id)));
  };
  /** True: backing storage accepted it (or it waits for this page's lock). An empty draft removes the slot. */
  const writeSlot = (runtimeKey: string, directory: string, slot: PersistedSlot | undefined): boolean => {
    const id = tabId();
    if (lock === 'pending') { pending.set(pendingKey(runtimeKey, directory), slot); return true; }
    const key = slotKey(runtimeKey, directory, id);
    if (!slot) { storage.removeItem(key); return true; }
    return put(key, JSON.stringify(slot));
  };

  /**
   * A tab with no New session draft of its own copies, once, the newest draft of a CLOSED tab (its claim released) in
   * the same project, or the given pre-#461 shared draft. `stored`: whether the copy reached backing storage; only then
   * is the copy marked (and a legacy entry may be removed by the caller).
   */
  function adoptOrphan(runtimeKey: string, directory: string, legacy?: PersistedSlot): { from: 'orphan' | 'legacy'; stored: boolean } | false {
    const mine = tabId();
    if (readSlot(runtimeKey, directory)) return false;
    const at = now();
    const candidates = slots().filter(s => s.runtimeKey === runtimeKey && s.directory === directory && s.tab !== mine);
    const marker = (tab: string) => { try { return JSON.parse(storage.getItem(ADOPTED + slotKey(runtimeKey, directory, tab)) ?? 'null') as { by: string; touchedAt: number; at: number } | null; } catch { return null; } };
    for (const s of candidates) { // Prune an adopted original only if unchanged since the copy, closed, and the copy is old.
      const m = marker(s.tab);
      if (m && m.touchedAt === s.slot.touchedAt && at - m.at > ADOPTED_KEEP_MS && storage.getItem(CLAIM + s.tab) === null) {
        storage.removeItem(s.key); storage.removeItem(ADOPTED + s.key);
      }
    }
    const orphan = candidates.filter(s => storage.getItem(CLAIM + s.tab) === null && marker(s.tab)?.touchedAt !== s.slot.touchedAt && !s.slot.adoptedBy)
      .sort((left, right) => right.slot.touchedAt - left.slot.touchedAt)[0];
    const source = orphan?.slot ?? legacy;
    if (!source) return false;
    const stored = writeSlot(runtimeKey, directory, { ...source, adoptedBy: undefined });
    if (stored && orphan) put(ADOPTED + orphan.key, JSON.stringify({ by: mine, touchedAt: orphan.slot.touchedAt, at }));
    return { from: orphan ? 'orphan' : 'legacy', stored };
  }

  return {
    tabId, readSlot, writeSlot, adoptOrphan,
    newSessionSlotKey: (runtimeKey: string, directory: string) => slotKey(runtimeKey, directory, tabId()),
    onPersistFailure: (listener: () => void) => { onFailure = listener; },
  };
}

const drafts = createTabDrafts({
  storage: getSafeStorage() as unknown as Env['storage'], session: getSafeSessionStorage(),
  locks: typeof navigator !== 'undefined' ? (navigator as { locks?: LockManagerLike }).locks ?? null : null,
  window: typeof window !== 'undefined' ? window : null,
});
export const { tabId, readSlot, writeSlot, adoptOrphan, newSessionSlotKey, onPersistFailure } = drafts;

/** Saves this tab's New session draft (an empty one removes it). undefined: nothing to change. */
export function writeTabDraft(runtimeKey: string, directory: string, previous: PersistedSlot | undefined, text: string,
  confirmedMentions: Iterable<string>, since: number | undefined, retry: boolean): boolean | undefined {
  const mentions = Array.from(new Set(confirmedMentions)), now = Date.now();
  if (!text && mentions.length === 0) return previous || retry ? writeSlot(runtimeKey, directory, undefined) : undefined;
  return writeSlot(runtimeKey, directory, { text, confirmedMentions: mentions, touchedAt: now,
    since: since ?? (previous?.text === text ? previous.since ?? previous.touchedAt : now) });
}
