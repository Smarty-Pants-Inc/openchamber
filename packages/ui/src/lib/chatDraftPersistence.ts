import { normalizePath } from '@/lib/pathNormalization';
import { getSafeSessionStorage, getSafeStorage } from '@/stores/utils/safeStorage';
import { countSyncPersistenceSerialization } from '@/sync/performance-diagnostics';

export type ChatDraftIdentity = {
  runtimeKey: string;
  directory: string;
  sessionId: string | null;
  /** Live new-draft generation only; never part of the durable key/envelope. */
  draftId?: number;
};

export type ChatDraftSnapshot = {
  text: string;
  confirmedMentions: Set<string>;
};

type PersistedChatDraft = {
  text: string;
  confirmedMentions: string[];
  touchedAt: number;
  /** When this exact text was set (any edit resets it): its provenance, kept across reloads. */
  since?: number;
};

type PersistedChatDraftEnvelope = {
  version: 2;
  drafts: Record<string, PersistedChatDraft>;
};

const STORAGE_KEY = 'openchamber.chatDrafts.v2';
const MAX_DRAFTS = 50;
// The composer already debounces typing. Lifecycle saves must reach backing storage now.
const storage = getSafeStorage();
const deletionListeners = new Set<(identity: ChatDraftIdentity) => void>();
const consumptionListeners = new Set<(identity: ChatDraftIdentity, submitted: string, before?: number) => void>();
const draftOwners = new Map<string, number>();
const persistenceListeners = new Set<() => void>();
let ephemeralOnly = false;

// One backing envelope owns all drafts, so a failed write affects every mounted reader.
export const isChatDraftEphemeral = (): boolean => ephemeralOnly;
export const subscribeChatDraftPersistence = (listener: () => void): (() => void) => {
  persistenceListeners.add(listener);
  return () => persistenceListeners.delete(listener);
};
let cachedRawEnvelope: string | null | undefined;
let cachedEnvelope: PersistedChatDraftEnvelope | undefined;

export const createChatDraftIdentity = (
  runtimeKey: string,
  directory: string | null | undefined,
  sessionId: string | null,
  draftId?: number,
): ChatDraftIdentity | null => {
  const normalizedDirectory = normalizePath(directory);
  if (!runtimeKey || !normalizedDirectory) return null;
  const identity: ChatDraftIdentity = { runtimeKey, directory: normalizedDirectory, sessionId };
  if (draftId !== undefined) identity.draftId = draftId;
  return identity;
};

const TAB_KEY = 'openchamber.chatDraftTab';
const TABS_KEY = 'openchamber.chatDraftTabs.v1';
const TAB_ALIVE_MS = 15_000;
/**
 * This tab's id: kept in sessionStorage, so it survives the tab's reloads and differs from other tabs'. A project's New
 * session draft is saved per tab: with one shared slot, a second tab's draft overwrote the first's, and the first tab came
 * back from a reload showing the other's text (smarty-code#461, 3.56). Each open tab marks itself alive every 5 s, so a
 * new tab can take over the draft of a tab that was closed (never one still open). ponytail: a duplicated tab copies
 * sessionStorage, so it starts with (and then shares) the original's draft slot.
 */
let tabIdCache: string | undefined;
const aliveTabs = (): Record<string, number> => { try { return JSON.parse(storage.getItem(TABS_KEY) ?? '{}') ?? {}; } catch { return {}; } };
const markAlive = (id: string): void => {
  const now = Date.now();
  const tabs = Object.fromEntries(Object.entries(aliveTabs()).filter(([, at]) => typeof at === 'number' && now - at < 3_600_000));
  storage.setItem(TABS_KEY, JSON.stringify({ ...tabs, [id]: now }));
};
const tabId = (): string => {
  const session = getSafeSessionStorage();
  let id = session.getItem(TAB_KEY);
  if (!id) {
    id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    session.setItem(TAB_KEY, id);
  }
  if (id !== tabIdCache) {
    tabIdCache = id;
    markAlive(id);
    if (typeof window !== 'undefined') setInterval(() => markAlive(id!), 5_000);
  }
  return id;
};

export const getChatDraftIdentityKey = (identity: ChatDraftIdentity): string => JSON.stringify(identity.sessionId === null
  ? [identity.runtimeKey, identity.directory, null, tabId()]
  : [identity.runtimeKey, identity.directory, identity.sessionId]);

/**
 * A tab with no New session draft of its own takes over, once, the newest one of a tab that is no longer open (a closed
 * tab's unsent text is never lost), or one saved before drafts were per tab. A draft of an open tab is never taken.
 */
const adoptOrphanDraft = (identity: ChatDraftIdentity): void => {
  if (identity.sessionId !== null) return;
  const envelope = readEnvelope();
  const key = getChatDraftIdentityKey(identity);
  if (key in envelope.drafts) return;
  const alive = aliveTabs(), now = Date.now();
  const orphan = Object.entries(envelope.drafts).filter(([other]) => {
    try {
      const [runtimeKey, directory, sessionId, tab] = JSON.parse(other) as [string, string, string | null, string?];
      return runtimeKey === identity.runtimeKey && directory === identity.directory && sessionId === null
        && (tab === undefined || !(now - (alive[tab] ?? 0) < TAB_ALIVE_MS));
    } catch { return false; }
  }).sort((left, right) => right[1].touchedAt - left[1].touchedAt)[0];
  if (!orphan) return;
  const drafts = { ...envelope.drafts, [key]: orphan[1] };
  delete drafts[orphan[0]];
  writeEnvelope({ version: 2, drafts });
};

/** The draft lifecycle claims a shared slot before a new generation can edit it. */
export const claimChatDraftOwnership = (identity: ChatDraftIdentity | null): void => {
  if (identity?.draftId !== undefined && identity.sessionId === null) {
    draftOwners.set(getChatDraftIdentityKey(identity), identity.draftId);
  }
};

const ownsChatDraft = (identity: ChatDraftIdentity): boolean => identity.draftId === undefined
  || draftOwners.get(getChatDraftIdentityKey(identity)) === identity.draftId;

const readEnvelope = (): PersistedChatDraftEnvelope => {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === cachedRawEnvelope && cachedEnvelope) return cachedEnvelope;
  try {
    const parsed = JSON.parse(raw ?? '') as Partial<PersistedChatDraftEnvelope>;
    if (parsed.version !== 2 || !parsed.drafts || typeof parsed.drafts !== 'object' || Array.isArray(parsed.drafts)) {
      cachedRawEnvelope = raw;
      cachedEnvelope = { version: 2, drafts: {} };
      return cachedEnvelope;
    }
    const drafts: Record<string, PersistedChatDraft> = {};
    for (const [key, value] of Object.entries(parsed.drafts)) {
      if (!value || typeof value !== 'object') continue;
      const draft = value as Partial<PersistedChatDraft>;
      if (typeof draft.text !== 'string' || !Array.isArray(draft.confirmedMentions) || typeof draft.touchedAt !== 'number') continue;
      drafts[key] = {
        text: draft.text,
        confirmedMentions: draft.confirmedMentions.filter((mention): mention is string => typeof mention === 'string'),
        touchedAt: draft.touchedAt,
        ...(typeof draft.since === 'number' ? { since: draft.since } : {}),
      };
    }
    cachedRawEnvelope = raw;
    cachedEnvelope = { version: 2, drafts };
    return cachedEnvelope;
  } catch {
    storage.removeItem(STORAGE_KEY);
    cachedRawEnvelope = null;
    cachedEnvelope = { version: 2, drafts: {} };
    return cachedEnvelope;
  }
};

const writeEnvelope = (envelope: PersistedChatDraftEnvelope): boolean => {
  const serialized = JSON.stringify(envelope);
  cachedRawEnvelope = serialized;
  cachedEnvelope = envelope;
  countSyncPersistenceSerialization(serialized);
  const stored = storage.setItem(STORAGE_KEY, serialized);
  if (ephemeralOnly !== !stored) {
    ephemeralOnly = !stored;
    persistenceListeners.forEach(listener => listener());
  }
  return stored;
};

export const readChatDraft = (identity: ChatDraftIdentity | null): ChatDraftSnapshot => {
  if (!identity) return { text: '', confirmedMentions: new Set() };
  adoptOrphanDraft(identity);
  const persisted = readEnvelope().drafts[getChatDraftIdentityKey(identity)];
  return persisted
    ? { text: persisted.text, confirmedMentions: new Set(persisted.confirmedMentions) }
    : { text: '', confirmedMentions: new Set() };
};

/** True means backing storage accepted the snapshot; false means memory only; undefined means no owned change. */
export const writeChatDraft = (
  identity: ChatDraftIdentity | null,
  text: string,
  confirmedMentions: Iterable<string>,
  /** The writing editor's own text start, when it knows it: never another tab's older draft's (#220). */
  since?: number,
): boolean | undefined => {
  if (!identity || !ownsChatDraft(identity)) return;
  const envelope = readEnvelope();
  const key = getChatDraftIdentityKey(identity);
  const mentions = Array.from(new Set(confirmedMentions));
  if (!text && mentions.length === 0) {
    // Retry an absent entry after failure: its deletion may exist only in memory.
    if (!(key in envelope.drafts) && !ephemeralOnly) return;
    delete envelope.drafts[key];
  } else {
    const previous = envelope.drafts[key];
    const now = Date.now();
    envelope.drafts[key] = { text, confirmedMentions: mentions, touchedAt: now,
      since: since ?? (previous?.text === text ? previous.since ?? previous.touchedAt : now) };
  }

  const retained = Object.entries(envelope.drafts)
    .sort((left, right) => right[1].touchedAt - left[1].touchedAt)
    .slice(0, MAX_DRAFTS);
  return writeEnvelope({ version: 2, drafts: Object.fromEntries(retained) });
};

/** When the saved draft's current text was set (older entries: when it was last saved); undefined when none is saved. */
export const readChatDraftSince = (identity: ChatDraftIdentity | null): number | undefined => {
  if (identity) adoptOrphanDraft(identity);
  const persisted = identity ? readEnvelope().drafts[getChatDraftIdentityKey(identity)] : undefined;
  return persisted?.text ? persisted.since ?? persisted.touchedAt : undefined;
};

/** A saved draft that began after `before` is a newer message, never a copy of text submitted then. */
export const savedChatDraftPredates = (identity: ChatDraftIdentity | null, before?: number): boolean =>
  before === undefined || (readChatDraftSince(identity) ?? 0) <= before;

/**
 * Current mounted consumers settle live edits first; unmounted inputs use their flushed snapshot. `before` (a
 * delivered text's admission time) consumes only copies that existed then: each editor judges its own copy, and the
 * shared saved slot clears only if its text began by then.
 */
export const consumeChatDraft = (identity: ChatDraftIdentity | null, submitted: string, before?: number): boolean => {
  if (!identity || !ownsChatDraft(identity)) return false;
  consumptionListeners.forEach(listener => listener(identity, submitted, before));
  if (!ownsChatDraft(identity)) return false;
  if (readChatDraft(identity).text === submitted && savedChatDraftPredates(identity, before)) writeChatDraft(identity, '', []);
  return true;
};

export const subscribeChatDraftConsumption = (listener: (identity: ChatDraftIdentity, submitted: string, before?: number) => void): (() => void) => {
  consumptionListeners.add(listener);
  return () => consumptionListeners.delete(listener);
};

export const clearChatDraft = (identity: ChatDraftIdentity, notify = false): void => {
  if (!ownsChatDraft(identity)) return;
  writeChatDraft(identity, '', []);
  if (notify) deletionListeners.forEach((listener) => listener(identity));
};

export const subscribeChatDraftDeletion = (listener: (identity: ChatDraftIdentity) => void): (() => void) => {
  deletionListeners.add(listener);
  return () => deletionListeners.delete(listener);
};
