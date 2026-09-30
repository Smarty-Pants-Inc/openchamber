import { normalizePath } from '@/lib/pathNormalization';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import { adoptLegacy, hasUnsaved, readSlot, retryUnsaved, tabId, writeTabDraft } from './chatDraftTabs';
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
const setEphemeral = (value: boolean): void => {
  if (ephemeralOnly === value) return;
  ephemeralOnly = value; persistenceListeners.forEach(listener => listener());
};

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

export const getChatDraftIdentityKey = (identity: ChatDraftIdentity): string => JSON.stringify(identity.sessionId === null
  ? [identity.runtimeKey, identity.directory, null, tabId()]
  : [identity.runtimeKey, identity.directory, identity.sessionId]);

/** The pre-#461 shared New session draft of a project (one slot for all tabs), if it is still stored. */
const legacyKeyOf = (identity: ChatDraftIdentity) => JSON.stringify([identity.runtimeKey, identity.directory, null]);
/** A durable save or clear of this tab's own draft supersedes the shared one: it goes (openchamber#433 r5 P1 3). */
const finishLegacy = (identity: ChatDraftIdentity): void => {
  const envelope = readEnvelope(), drafts = { ...envelope.drafts };
  let changed = false;
  for (const key of [legacyKeyOf(identity), ...retryUnsaved()]) if (key in drafts) {
    delete drafts[key]; changed = true;
  }
  // Retry an earlier refused envelope cleanup too, even if its deletion is already visible in page memory.
  if (changed || ephemeralOnly) writeEnvelope({ version: 2, drafts });
  else setEphemeral(hasUnsaved());
};
/** A New session draft is this tab's own slot (chatDraftTabs.ts, #461); a session's draft stays in the envelope. */
const tabDraft = (identity: ChatDraftIdentity): PersistedChatDraft | undefined => {
  const adopted = adoptLegacy(identity.runtimeKey, identity.directory, readEnvelope().drafts[legacyKeyOf(identity)]);
  // The shared entry goes only once this tab's copy is durable; a refused copy is reported, and a later durable
  // save or clear of this tab's draft finishes the migration (writeChatDraft).
  if (adopted && !adopted.stored) setEphemeral(true);
  else if (adopted) finishLegacy(identity);
  return readSlot(identity.runtimeKey, identity.directory);
};
const savedDraft = (identity: ChatDraftIdentity): PersistedChatDraft | undefined => identity.sessionId === null
  ? tabDraft(identity) : readEnvelope().drafts[getChatDraftIdentityKey(identity)];

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
  const persist = (value: PersistedChatDraftEnvelope): boolean => {
    const serialized = JSON.stringify(value);
    cachedRawEnvelope = serialized;
    cachedEnvelope = value;
    countSyncPersistenceSerialization(serialized);
    return storage.setItem(STORAGE_KEY, serialized);
  };
  let stored = persist(envelope);
  if (stored) {
    const completed = retryUnsaved().filter(key => key in envelope.drafts);
    if (completed.length) {
      const drafts = { ...envelope.drafts };
      for (const key of completed) delete drafts[key];
      // No recursive retry: the slots are durable, but the shared legacy removal must be durable as well.
      stored = persist({ version: 2, drafts });
    }
  }
  setEphemeral(!stored || hasUnsaved()); // A refused slot or envelope cleanup keeps the warning on.
  return stored;
};

export const readChatDraft = (identity: ChatDraftIdentity | null): ChatDraftSnapshot => {
  if (!identity) return { text: '', confirmedMentions: new Set() };
  const persisted = savedDraft(identity);
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
  if (identity.sessionId === null) {
    const stored = writeTabDraft(identity.runtimeKey, identity.directory, savedDraft(identity), text, confirmedMentions, since, ephemeralOnly);
    // The warning stays on while any refused write of this tab (another project's clear included) is still owed.
    if (stored) finishLegacy(identity);
    else if (stored === false) setEphemeral(true);
    return stored;
  }
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
  const persisted = identity ? savedDraft(identity) : undefined;
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
