import { z } from 'zod';
import { getSafeSessionStorage, getSafeStorage } from '@/stores/utils/safeStorage';

/**
 * A project's New session draft, saved per browser tab (smarty-code#461): with one shared slot, a second tab's draft
 * overwrote the first's. Design after openchamber#433 round 3 (scope decision: code-lead, 2026-09-30; cut items in
 * smarty-code#1039). localStorage has no atomic cross-page operation, so a page writes and removes ONLY its own keys:
 * - Every page load takes a FRESH id. The tab's LINEAGE (this id, then its earlier loads' ids, newest first) is kept in
 *   sessionStorage. No two pages ever write one key: a duplicated tab (which copies sessionStorage) gets its own id.
 * - A page reads its project's draft from its own slot, else from the newest slot along its lineage, and copies it
 *   (read only). A refused copy leaves the earlier slot where the next load finds it again (openchamber#433 r4 P1 1).
 * - Clearing or sending writes a CLEARED marker in the page's own slot instead of removing it: the lineage walk stops
 *   there, so an earlier load's snapshot never returns as unsent text (r4 P1 2).
 * - Each copied slot names the slot it came from (`from`). A fresh tab (empty lineage) copies, once per project, the
 *   newest slot that no other slot came from and that is not cleared, or the pre-#461 shared draft if that is newer.
 */
const slotSchema = z.object({
  text: z.string(), confirmedMentions: z.array(z.string()), touchedAt: z.number(), since: z.number().optional(),
  cleared: z.boolean().optional(), from: z.string().optional(),
});
export type PersistedSlot = { text: string; confirmedMentions: string[]; touchedAt: number; since?: number };
type StoredSlot = z.infer<typeof slotSchema>;
type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): boolean | void; removeItem(key: string): void;
  key(index: number): string | null; readonly length: number };
type Env = { storage: Storage; session: Pick<Storage, 'getItem' | 'setItem'>; now?: () => number };

const TAB_KEY = 'openchamber.chatDraftTab';
const SLOT = 'openchamber.chatDraftSlot:';
const LINEAGE_MAX = 8;
const keySchema = z.tuple([z.string(), z.string(), z.string()]);
const lineageSchema = z.array(z.string()).max(LINEAGE_MAX);
const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const slotKey = (runtimeKey: string, directory: string, tab: string) => SLOT + JSON.stringify([runtimeKey, directory, tab]);
/** A stored JSON value checked against its schema; undefined when absent, not JSON, or not that shape. */
function parseJson<T extends z.ZodTypeAny>(schema: T, raw: string | null): z.infer<T> | undefined {
  if (raw === null) return undefined;
  try { return schema.safeParse(JSON.parse(raw)).data; } catch { return undefined; }
}
const parseSlot = (raw: string | null): StoredSlot | undefined => parseJson(slotSchema, raw);
/** The tab's earlier ids, newest first. A pre-lineage value (one id) counts as a lineage of one. */
const parseLineage = (raw: string | null): string[] => {
  if (!raw) return [];
  return parseJson(lineageSchema, raw) ?? [raw];
};
function draftOf(slot: StoredSlot | undefined): PersistedSlot | undefined {
  if (!slot || slot.cleared) return undefined;
  const draft: PersistedSlot = { text: slot.text, confirmedMentions: slot.confirmedMentions, touchedAt: slot.touchedAt };
  if (slot.since !== undefined) draft.since = slot.since;
  return draft;
}

/** One page's view of the per-tab drafts (a module instance is one page; tests make several). */
export function createTabDrafts(env: Env) {
  const { storage, session } = env, now = env.now ?? Date.now;
  let id: string | undefined, lineage: string[] = [];
  const settled = new Set<string>(); // Projects this page already looked up (copied or found nothing), once each.
  const origin = new Map<string, string>(); // Project -> the slot key this page's slot was copied from.
  let failure: (() => void) | undefined;
  const put = (key: string, value: StoredSlot) => storage.setItem(key, JSON.stringify(value)) !== false;
  const project = (runtimeKey: string, directory: string) => JSON.stringify([runtimeKey, directory]);
  const slots = () => {
    const found: { key: string; runtimeKey: string; directory: string; tab: string; slot: StoredSlot }[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(SLOT)) continue;
      const parts = parseJson(keySchema, key.slice(SLOT.length)), slot = parseSlot(storage.getItem(key));
      if (parts && slot) found.push({ key, runtimeKey: parts[0], directory: parts[1], tab: parts[2], slot });
    }
    return found;
  };

  /** This page's id: new at every load; the tab's earlier ids stay in its lineage. */
  function tabId(): string {
    if (id) return id;
    lineage = parseLineage(session.getItem(TAB_KEY));
    id = newId();
    session.setItem(TAB_KEY, JSON.stringify([id, ...lineage].slice(0, LINEAGE_MAX)));
    return id;
  }

  /** This page's own slot, or (once per project) a read-only copy of the newest slot along its lineage. */
  const own = (runtimeKey: string, directory: string): StoredSlot | undefined => {
    const mine = tabId(), key = slotKey(runtimeKey, directory, mine), stored = parseSlot(storage.getItem(key));
    const p = project(runtimeKey, directory);
    if (stored || settled.has(p)) return stored;
    settled.add(p);
    for (const earlier of lineage) {
      const from = slotKey(runtimeKey, directory, earlier), slot = parseSlot(storage.getItem(from));
      if (!slot) continue;
      if (slot.cleared) return undefined; // Cleared or sent at that load: nothing to restore.
      origin.set(p, from);
      const copy = { ...slot, from };
      if (!put(key, copy)) failure?.(); // Refused: the earlier slot stays in the lineage for the next load.
      return copy;
    }
    return undefined;
  };

  const readSlot = (runtimeKey: string, directory: string): PersistedSlot | undefined => draftOf(own(runtimeKey, directory));
  /** True only when backing storage accepted it. An empty draft leaves a cleared marker in this page's slot. */
  const writeSlot = (runtimeKey: string, directory: string, slot: PersistedSlot | undefined): boolean => {
    own(runtimeKey, directory);
    const from = origin.get(project(runtimeKey, directory));
    const next: StoredSlot = slot ? { ...slot } : { text: '', confirmedMentions: [], touchedAt: now(), cleared: true };
    if (from) next.from = from;
    return put(slotKey(runtimeKey, directory, tabId()), next);
  };

  /**
   * A FRESH tab (empty lineage) with no draft of its own copies, once per project, the newest slot that is a current
   * draft (no other slot came from it, and it is not cleared), or the given pre-#461 shared draft if that is newer.
   * Nothing else is written or removed. `stored`: the copy reached backing storage.
   */
  function adoptNewest(runtimeKey: string, directory: string, legacy?: PersistedSlot): { from: 'tab' | 'legacy'; stored: boolean } | false {
    const mine = tabId();
    if (lineage.length || own(runtimeKey, directory)) return false;
    const inProject = slots().filter(s => s.runtimeKey === runtimeKey && s.directory === directory && s.tab !== mine);
    const superseded = new Set(inProject.flatMap(s => (s.slot.from ? [s.slot.from] : [])));
    const newest = inProject.filter(s => !s.slot.cleared && !superseded.has(s.key))
      .sort((left, right) => right.slot.touchedAt - left.slot.touchedAt)[0];
    const fromLegacy = !newest || (legacy !== undefined && legacy.touchedAt > newest.slot.touchedAt);
    const source = fromLegacy ? legacy : draftOf(newest.slot);
    if (!source) return false;
    if (!fromLegacy && newest) origin.set(project(runtimeKey, directory), newest.key);
    const stored = writeSlot(runtimeKey, directory, source);
    if (!stored) failure?.();
    return { from: fromLegacy ? 'legacy' : 'tab', stored };
  }

  return { tabId, readSlot, writeSlot, adoptNewest, onCopyRefused: (listener: () => void) => { failure = listener; },
    newSessionSlotKey: (runtimeKey: string, directory: string) => slotKey(runtimeKey, directory, tabId()) };
}

const drafts = createTabDrafts({ storage: getSafeStorage(), session: getSafeSessionStorage() });
export const { tabId, readSlot, writeSlot, adoptNewest, newSessionSlotKey, onCopyRefused } = drafts;

/** Saves this tab's New session draft (an empty one leaves a cleared marker). undefined: nothing to change. */
export function writeTabDraft(runtimeKey: string, directory: string, previous: PersistedSlot | undefined, text: string,
  confirmedMentions: Iterable<string>, since: number | undefined, retry: boolean): boolean | undefined {
  const mentions = Array.from(new Set(confirmedMentions)), now = Date.now();
  if (!text && mentions.length === 0) return previous || retry ? writeSlot(runtimeKey, directory, undefined) : undefined;
  return writeSlot(runtimeKey, directory, { text, confirmedMentions: mentions, touchedAt: now,
    since: since ?? (previous?.text === text ? previous.since ?? previous.touchedAt : now) });
}
