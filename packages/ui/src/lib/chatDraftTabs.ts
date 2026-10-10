import { z } from 'zod';
import { getSafeSessionStorage, getSafeStorage } from '@/stores/utils/safeStorage';

/**
 * A project's New session draft, saved per browser tab: with one shared slot, a second tab's draft overwrote the
 * first's. This keeps the least state that keeps tabs apart.
 * - A tab's id lives in sessionStorage, so it is stable across that tab's reloads and differs between tabs. Its draft is
 *   ONE localStorage key, which only that tab writes. A page writes an id, and publishes it in sessionStorage, only
 *   once it holds the id's exclusive Web Lock; until then its writes are held in memory. A save counts as done only when both the draft and the id are
 *   stored; a clear writes an empty draft (a refused write is seen; a refused removal is not).
 * - A fresh tab starts empty. The older shared draft is copied once into the first tab that reads it; the caller
 *   removes the shared entry only after that copy is durably stored.
 * - A duplicated tab, or a window opened by this one, starts with a copy of this tab's sessionStorage, id
 *   included. The page granted the id's lock owns its slots; any other page takes a new id and COPIES the source's
 *   drafts (text, mentions, since): it never moves or removes them. Before its grant, a page reads the inherited
 *   slots. A copy made before a fresh page's first grant finds no published id, so it starts as a fresh tab. Without
 *   working Web Locks (an insecure context, an old browser, a rejected request) a page writes only an id it minted;
 *   every inherited id is copied: isolated, never overwritten.
 *   If the page is hidden, frozen or leaving before its grant, it writes the source copy and its held writes at once
 *   under a STAGED id (the unpublished id it would own) and records it beside the published one in the same
 *   sessionStorage value, so the composer's lifecycle save that follows is stored. A later load (a reload or a copy)
 *   only reads and copies a staged id, never claims or writes it. The grant then places the newest held writes; a late
 *   grant of the inherited id is declined when any of its slots changed since staging (its owner saved after this page
 *   copied them), and the page copies into its own id instead.
 * Accepted limits: a fresh tab does not restore another tab's draft, nor does a copy made before the source's first
 *   grant; a page that cannot take the lock (a reload racing its old page's release, no Web Locks) or that staged
 *   leaves the source or staged slots behind as retained drafts.
 */
const slotSchema = z.object({ text: z.string(), confirmedMentions: z.array(z.string()), touchedAt: z.number(), since: z.number().optional() });
export type PersistedSlot = z.infer<typeof slotSchema>;
type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): boolean | void; readonly length: number; key(index: number): string | null };
/** The part of the browser's LockManager this module uses. */
type TabLocks = { request(name: string, options: { mode: 'exclusive'; ifAvailable: true },
  grant: (lock: { name: string } | null) => Promise<void> | undefined): Promise<void | undefined> };
type Env = { storage: Storage; session: Pick<Storage, 'getItem' | 'setItem'>; locks?: TabLocks };

const TAB_KEY = 'openchamber.chatDraftTab';
const SLOT = 'openchamber.chatDraftSlot:';
const LOCK = 'openchamber.chatDraftTab:';
const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const slotKey = (runtimeKey: string, directory: string, tab: string) => SLOT + JSON.stringify([runtimeKey, directory, tab]);
const slotKeySchema = z.tuple([z.string(), z.string(), z.string()]);
const slotOwner = (key: string): [string, string, string] | undefined => {
  if (!key.startsWith(SLOT)) return undefined;
  try { return slotKeySchema.safeParse(JSON.parse(key.slice(SLOT.length))).data; } catch { return undefined; }
};
function parseSlot(raw: string | null): PersistedSlot | undefined {
  if (raw === null) return undefined;
  try { return slotSchema.safeParse(JSON.parse(raw)).data; } catch { return undefined; }
}
const hasDraft = (slot: PersistedSlot | undefined) => !!slot && (!!slot.text || slot.confirmedMentions.length > 0);

/**
 * Asks for `tab`'s exclusive lock and holds it for this page's life when granted. Never waits for another holder.
 * `accept` runs when the browser grants it; declining releases the lock at once and reports it 'held'.
 * 'failed': Web Locks could not answer (the request threw or rejected).
 */
const claim = (locks: TabLocks, tab: string, accept = () => true) => new Promise<'granted' | 'held' | 'failed'>((resolve) => {
  try {
    locks.request(LOCK + tab, { mode: 'exclusive', ifAvailable: true }, (lock) => {
      const taken = lock !== null && accept();
      resolve(taken ? 'granted' : 'held');
      return taken ? new Promise<void>(() => {}) : undefined; // Released by the browser when the page goes.
    }).catch(() => resolve('failed'));
  } catch { resolve('failed'); }
});
/**
 * The tab's sessionStorage record, always a tuple: its published id (granted the native lock) and the staged copy a page
 * stopping before its grant left. A plain string is an id saved by an older version, published without a native lock: that
 * page may still be live and writing it, so it is read and copied only, never claimed, even when its lock is free.
 */
const tabRecordSchema = z.tuple([z.string(), z.string()]);
/** `published`: an id its owner holds the lock for (a later load may claim it). `staged`: read and copied only. */
type TabRecord = { published?: string; staged?: string };
function parseTabRecord(raw: string | null): TabRecord {
  if (!raw) return {};
  if (!raw.startsWith('[')) return { staged: raw };
  try {
    const [published, staged] = tabRecordSchema.parse(JSON.parse(raw));
    return { published: published || undefined, staged: staged || undefined };
  } catch { return {}; }
}

/** One page's view of its tab's drafts (tests make several). */
export function createTabDrafts(env: Env) {
  const { storage, session } = env;
  const locks = 'locks' in env ? env.locks : globalThis.navigator?.locks;
  const { published: candidate, staged: inheritedStage } = parseTabRecord(session.getItem(TAB_KEY));
  /** This page's own token for page-local keys; it never changes, whichever id the page ends up owning. */
  const page = candidate ?? inheritedStage ?? newId();
  /** The drafts this page starts from: a staged copy is newer than the published id's slots. Read and copied, never written. */
  const source = inheritedStage ?? candidate;
  /** The id this page owns when it does not get the candidate. Never published before its grant. */
  let fresh = candidate === undefined && inheritedStage === undefined ? page : newId();
  /** The id whose slots this page writes: set only once its native lock is granted (or Web Locks cannot answer). */
  let id: string | undefined;
  /** Whether this page holds `id`'s native lock; without it, `id` is recorded as staged so every later load copies it. */
  let granted = false;
  /** Where this page stages writes after it stopped before its grant: a never-claimed id only this page writes. */
  let stage: string | undefined;
  let storedRecord: string | undefined;
  // A browser Storage returns undefined; the safe adapters return false when the value stayed in page memory only.
  const stored = (result: boolean | void) => result !== false;
  /** Saves where this tab's next load finds its drafts; false while sessionStorage refuses it (#433 r6 P1 2). */
  const storeId = () => {
    const staged = granted ? undefined : id ?? stage;
    const record = granted ? JSON.stringify([id, '']) : staged === undefined ? undefined : JSON.stringify([candidate ?? '', staged]);
    if (record === undefined) return false;
    if (storedRecord !== record && stored(session.setItem(TAB_KEY, record))) storedRecord = record;
    return storedRecord === record;
  };
  /** This page's identity for page-local keys (its tab's id at load): the same for the page's whole life. */
  const tabId = (): string => page;
  const ownKey = (runtimeKey: string, directory: string) => slotKey(runtimeKey, directory, id ?? stage ?? source ?? fresh);
  const legacyKeyOf = (runtimeKey: string, directory: string) => JSON.stringify([runtimeKey, directory, null]);
  /** Writes made before the grant, by project; the latest wins. They go to the owned id, never the candidate. */
  const deferred = new Map<string, { runtimeKey: string; directory: string; value: string; finishLegacy?: () => void }>();
  const projectKey = (runtimeKey: string, directory: string) => JSON.stringify([runtimeKey, directory]);
  const sourceRaw = (runtimeKey: string, directory: string) => (source === undefined ? null : storage.getItem(slotKey(runtimeKey, directory, source)));
  /** The saved slot this page's reads fall back to: its own once owned, the source before. */
  const savedRaw = (runtimeKey: string, directory: string) => (id === undefined ? sourceRaw(runtimeKey, directory) : storage.getItem(ownKey(runtimeKey, directory)));
  /** This tab's draft; a cleared slot (an empty text: a clear or a consumed send) is no draft. */
  function readSlot(runtimeKey: string, directory: string): PersistedSlot | undefined {
    const key = ownKey(runtimeKey, directory);
    const slot = parseSlot(deferred.get(projectKey(runtimeKey, directory))?.value ?? (id === undefined ? null : unsaved.get(key)?.value ?? null) ?? savedRaw(runtimeKey, directory));
    return hasDraft(slot) ? slot : undefined;
  }
  function put(key: string, value: string, legacyKey: string): boolean {
    const ok = stored(storage.setItem(key, value)) && storeId();
    if (!ok) { unsaved.set(key, { value, legacyKey }); return false; }
    unsaved.delete(key);
    // The persistence owner retries other keys and durably removes their superseded legacy entries.
    return true;
  }
  /**
   * True only when the draft is reload-safe: backing storage accepted it AND this tab's record is saved (its next load
   * finds the slot). An empty draft is WRITTEN as a cleared slot, not removed: a refused removal is invisible (the adapter
   * hides the old value in page memory only), a refused write is reported (#433 r6 P1 3). undefined: held until the
   * grant (nothing saved yet, nothing refused).
   */
  function writeSlot(runtimeKey: string, directory: string, slot: PersistedSlot | undefined, now = Date.now()): boolean | undefined {
    const value = JSON.stringify(slot ?? { text: '', confirmedMentions: [], touchedAt: now });
    if (id === undefined) {
      const key = projectKey(runtimeKey, directory);
      deferred.set(key, { runtimeKey, directory, value, finishLegacy: deferred.get(key)?.finishLegacy });
      return stage === undefined ? undefined : put(slotKey(runtimeKey, directory, stage), value, legacyKeyOf(runtimeKey, directory));
    }
    return put(ownKey(runtimeKey, directory), value, legacyKeyOf(runtimeKey, directory));
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
  /** Whether this tab's draft of the project has a refused (or not yet placed) write still owed. */
  const owes = (runtimeKey: string, directory: string) => deferred.has(projectKey(runtimeKey, directory)) || unsaved.has(ownKey(runtimeKey, directory));
  /** The pre-#461 shared draft, copied into this tab when it has none. `stored`: the copy reached backing storage. */
  function adoptLegacy(runtimeKey: string, directory: string, legacy: PersistedSlot | undefined, finishLegacy?: () => void): { stored: boolean } | false {
    // A valid own (or source) slot, including a pending or durable empty tombstone, supersedes shared legacy text.
    if (!legacy || owes(runtimeKey, directory) || parseSlot(savedRaw(runtimeKey, directory))) return false;
    const result = writeSlot(runtimeKey, directory, legacy);
    const pending = deferred.get(projectKey(runtimeKey, directory));
    if (pending) pending.finishLegacy = finishLegacy;
    // Held until the grant: shown now; durable placement or a later retry retires the shared entry.
    return result === undefined ? false : { stored: result };
  }
  /**
   * Writes the source's valid slots (cleared ones too: a durable clear must keep superseding the shared legacy draft),
   * then the held writes, under `target`; publishes the tab record last. Copies, never moves: the source is untouched.
   */
  function place(target: string) {
    const writes = new Map<string, { value: string; legacyKey: string }>();
    if (source !== undefined && source !== target) for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index), parts = key === null ? undefined : slotOwner(key);
      if (key === null || parts?.[2] !== source || deferred.has(projectKey(parts[0], parts[1]))) continue;
      const raw = storage.getItem(key);
      if (parseSlot(raw)) writes.set(slotKey(parts[0], parts[1], target), { value: raw!, legacyKey: legacyKeyOf(parts[0], parts[1]) });
    }
    for (const { runtimeKey, directory, value } of deferred.values()) writes.set(slotKey(runtimeKey, directory, target), { value, legacyKey: legacyKeyOf(runtimeKey, directory) });
    const placed: [string, { value: string; legacyKey: string }][] = [];
    for (const [key, pending] of writes) {
      if (stored(storage.setItem(key, pending.value))) { unsaved.delete(key); placed.push([key, pending]); } else unsaved.set(key, pending);
    }
    if (!storeId()) for (const [key, pending] of placed) unsaved.set(key, pending);
  }
  /** The native lock of `owner` is granted: place the source copy and held writes there, then publish it. */
  function settle(owner: string, lockHeld: boolean) {
    id = owner; granted = lockHeld;
    unsaved.clear(); // Owed staged writes only: their latest values are held and placed now.
    place(owner);
    const pending = [...deferred.values()];
    deferred.clear();
    // A refused slot or tab record still owes its copy; the persistence owner's retry finishes that migration.
    for (const draft of pending) if (!unsaved.has(ownKey(draft.runtimeKey, draft.directory))) draft.finishLegacy?.();
  }
  /**
   * Claims a new id this page minted. Web Locks that cannot answer leave the page writing that id unlocked, recorded
   * as staged: an opener whose Web Locks work copies it and never claims it.
   */
  const own = (): Promise<void> => {
    if (!locks) { settle(fresh, false); return Promise.resolve(); }
    return claim(locks, fresh).then((result) => {
      if (result !== 'held') { settle(fresh, result === 'granted'); return undefined; }
      fresh = newId(); // Never expected (the id was unpublished); still, only a granted id is written.
      return own();
    });
  };
  /** The source's slots (every project) when this page staged: their exact stored bytes, by key. */
  let stagedSource: Map<string, string> | undefined;
  const sourceSlots = () => {
    const slots = new Map<string, string>();
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key === null || slotOwner(key)?.[2] !== source) continue;
      const raw = storage.getItem(key);
      if (raw !== null) slots.set(key, raw);
    }
    return slots;
  };
  /**
   * Whether a late grant of the candidate may still be settled. After staging, another page (the id's owner, still
   * live when this page staged) may have saved newer drafts there; any change to its slots since staging makes this
   * page take its own id and copy them instead.
   */
  const sourceUnchanged = () => {
    const before = stagedSource;
    if (before === undefined) return true;
    const now = sourceSlots();
    return now.size === before.size && [...now].every(([key, raw]) => before.get(key) === raw);
  };
  // A staged record never claims its published id, even when free: that id's owner may have saved newer drafts there.
  const ready: Promise<void> = candidate === undefined || inheritedStage !== undefined || !locks ? own()
    : claim(locks, candidate, sourceUnchanged).then(result => (result === 'granted' ? settle(candidate, true) : own()));
  /**
   * The page may stop before its grant: stage the source copy and held writes, synchronously, under the id it would
   * own and record it as staged. A staged id is never claimed by a later load: copies and reloads only read it.
   */
  function suspend() {
    if (id !== undefined || stage !== undefined) return;
    stage = fresh;
    stagedSource = sourceSlots();
    place(stage);
  }
  return { tabId, readSlot, writeSlot, adoptLegacy, owes, retryUnsaved, hasUnsaved: () => unsaved.size > 0, suspend,
    /** This page's id is granted and held writes are placed. */
    ready,
    newSessionSlotKey: ownKey };
}

const drafts = createTabDrafts({ storage: getSafeStorage(), session: getSafeSessionStorage() });
export const { tabId, readSlot, writeSlot, adoptLegacy, newSessionSlotKey, owes, retryUnsaved, hasUnsaved } = drafts;
/** This page's storage ownership is known; a held write storage then refused is owed (hasUnsaved). */
export const tabDraftsReady = drafts.ready;
// Capture listeners added at load run before the composer's lifecycle save on the same edge, so that save is stored.
const suspendDrafts = () => drafts.suspend();
globalThis.window?.addEventListener('pagehide', suspendDrafts, { capture: true });
globalThis.document?.addEventListener('freeze', suspendDrafts, { capture: true });
globalThis.document?.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') suspendDrafts();
}, { capture: true });

/** Saves this tab's New session draft (an empty one removes it). undefined: nothing to change. */
export function writeTabDraft(runtimeKey: string, directory: string, previous: PersistedSlot | undefined, text: string,
  confirmedMentions: Iterable<string>, since: number | undefined, retry: boolean): boolean | undefined {
  const mentions = Array.from(new Set(confirmedMentions)), now = Date.now();
  if (!text && mentions.length === 0) return previous || retry || owes(runtimeKey, directory) ? writeSlot(runtimeKey, directory, undefined) : undefined;
  return writeSlot(runtimeKey, directory, { text, confirmedMentions: mentions, touchedAt: now,
    since: since ?? (previous?.text === text ? previous.since ?? previous.touchedAt : now) });
}
