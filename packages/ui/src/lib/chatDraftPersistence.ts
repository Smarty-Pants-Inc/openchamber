import { normalizePath } from '@/lib/pathNormalization';
import { getSafeStorage } from '@/stores/utils/safeStorage';
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
const consumptionListeners = new Set<(identity: ChatDraftIdentity, submitted: string) => void>();
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

export const getChatDraftIdentityKey = (identity: ChatDraftIdentity): string =>
  JSON.stringify([identity.runtimeKey, identity.directory, identity.sessionId]);

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
    envelope.drafts[key] = { text, confirmedMentions: mentions, touchedAt: Date.now() };
  }

  const retained = Object.entries(envelope.drafts)
    .sort((left, right) => right[1].touchedAt - left[1].touchedAt)
    .slice(0, MAX_DRAFTS);
  return writeEnvelope({ version: 2, drafts: Object.fromEntries(retained) });
};

/** Current mounted consumers settle live edits first; unmounted inputs use their flushed snapshot. */
export const consumeChatDraft = (identity: ChatDraftIdentity | null, submitted: string): boolean => {
  if (!identity || !ownsChatDraft(identity)) return false;
  consumptionListeners.forEach(listener => listener(identity, submitted));
  if (!ownsChatDraft(identity)) return false;
  if (readChatDraft(identity).text === submitted) writeChatDraft(identity, '', []);
  return true;
};

export const subscribeChatDraftConsumption = (listener: (identity: ChatDraftIdentity, submitted: string) => void): (() => void) => {
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
