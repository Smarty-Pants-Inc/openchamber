import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { z } from 'zod';
import type { Event } from '@opencode-ai/sdk/v2';
import { createInputHistoryIdentity, createInputHistorySubmission, useInputHistoryStore } from './useInputHistoryStore';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';
import type { AttachedFile } from './types/sessionTypes';
import { contextPartMetadataSchema, type ContextPartMetadata } from '@/lib/messages/contextParts';
import { updateDesktopSettings } from '@/lib/persistence';
import { captureRuntimeRequestScope, getRuntimeKey, isRuntimeRequestScopeCurrent } from '@/lib/runtime-switch';
import { isVSCodeRuntime } from '@/lib/desktop';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { normalizePath } from '@/lib/pathNormalization';
import { opencodeClient } from '@/lib/opencode/client';

export type FollowUpBehavior = 'steer' | 'queue';

export const DEFAULT_FOLLOW_UP_BEHAVIOR: FollowUpBehavior = 'queue';

export const isFollowUpBehavior = (value: unknown): value is FollowUpBehavior => (
    value === 'steer' || value === 'queue'
);

export const normalizeFollowUpBehavior = (
    value: unknown,
    legacyQueueModeEnabled?: boolean | null,
): FollowUpBehavior => {
    // "immediate" was removed: on a busy session it was wire-identical to
    // "steer" (OpenCode only supports delivery "steer" | "queue", defaulting
    // to "steer"), so collapse any persisted/legacy "immediate" onto "steer".
    if (value === 'immediate') {
        return 'steer';
    }

    if (isFollowUpBehavior(value)) {
        return value;
    }

    if (legacyQueueModeEnabled === false) {
        return 'steer';
    }

    if (legacyQueueModeEnabled === true) {
        return 'queue';
    }

    return DEFAULT_FOLLOW_UP_BEHAVIOR;
};

/**
 * Who delivers the queue. Web, desktop, and mobile talk to an OpenChamber
 * server that owns the queue and sends it whether or not any UI is open. VS
 * Code has no server of its own, so the extension UI keeps the local queue
 * and the foreground auto-send hook.
 */
export const isServerOwnedMessageQueue = (): boolean => !isVSCodeRuntime();

export interface QueuedMessageSendConfig {
    providerID: string;
    modelID: string;
    agent?: string;
    variant?: string;
}

/**
 * Context captured with a queued message: whatever the composer had attached
 * when the message was queued. It leaves the composer with the message, so
 * delivery (by the server, or by the auto-send hook in VS Code) carries it and
 * editing the message brings it back.
 */
export type QueuedContextPart =
    | {
        /** An attached context item: a draft chip or a linked issue/PR. Restored on edit. */
        kind: 'context';
        text: string;
        metadata: ContextPartMetadata;
        /** Delivered as its own synthetic part right before this one (a linked PR's reading instructions). */
        instructions?: string;
    }
    | {
        /** Derived from the message text (the skill instruction); re-derived when the text is sent again, so never restored. */
        kind: 'instruction';
        text: string;
    }
    | {
        /** Handed to the composer by another surface (conflict resolution); restored as pending on edit. */
        kind: 'synthetic';
        text: string;
    };

export interface QueuedMessage {
    id: string;
    state?: 'pending' | 'attempting' | 'unknown' | 'blocked' | 'taken' | 'unconfirmed';
    /** What the user typed, for display and editing. */
    content: string;
    /** What is delivered: `content` without its leading agent mention, file mentions already resolved. */
    text: string;
    /** Agent mentioned at the start of `content`, delivered as an agent part. */
    agentMention?: string;
    attachments?: AttachedFile[];
    /** Absent on a server projection item; a take brings it back. */
    context?: QueuedContextPart[];
    createdAt: number;
    /** Send config captured at queue time — used as-is when auto-sending */
    sendConfig?: QueuedMessageSendConfig;
}

interface QueuedMessageInput {
    content: string;
    /** Defaults to `content`. */
    text?: string;
    agentMention?: string;
    attachments?: AttachedFile[];
    context?: QueuedContextPart[];
    sendConfig?: QueuedMessageSendConfig;
}

export type MessageQueueTarget = {
    runtimeKey: string;
    directory: string;
    sessionId: string;
};

const MAX_QUEUE_TARGETS = 50;
const MAX_MESSAGES_PER_QUEUE = 20;

export const createMessageQueueTarget = (
    sessionId: string,
    directory: string | null | undefined,
    runtimeKey: string = getRuntimeKey(),
): MessageQueueTarget | null => {
    const normalizedDirectory = normalizePath(directory);
    if (!runtimeKey || !normalizedDirectory || !sessionId) return null;
    return { runtimeKey, directory: normalizedDirectory, sessionId };
};

export const getMessageQueueKey = (target: MessageQueueTarget): string =>
    `${target.runtimeKey}\n${target.directory}\n${target.sessionId}`;

export const parseMessageQueueKey = (key: string): MessageQueueTarget | null => {
    const [runtimeKey, directory, ...sessionParts] = key.split('\n');
    return createMessageQueueTarget(sessionParts.join('\n'), directory, runtimeKey);
};

// ---------------------------------------------------------------------------
// Server contract (packages/web/server/lib/message-queue)
// ---------------------------------------------------------------------------

const serverSendConfigSchema = z.object({
    providerID: z.string().min(1),
    modelID: z.string().min(1),
    agent: z.string().optional(),
    variant: z.string().optional(),
});

const serverAttachmentSchema = z.object({
    id: z.string(),
    filename: z.string(),
    mimeType: z.string(),
    size: z.number(),
    source: z.enum(['local', 'server', 'vscode']),
    serverPath: z.string().optional(),
    /** Present only on a taken item; broadcasts and snapshots omit payloads. */
    dataUrl: z.string().optional(),
});

const serverContextPartSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('context'),
        text: z.string(),
        metadata: contextPartMetadataSchema,
        instructions: z.string().optional(),
    }),
    z.object({ kind: z.literal('instruction'), text: z.string() }),
    z.object({ kind: z.literal('synthetic'), text: z.string() }),
]);

const serverItemSchema = z.object({
    id: z.string().min(1),
    createdAt: z.number(),
    content: z.string(),
    text: z.string(),
    agentMention: z.string().optional(),
    attachments: z.array(serverAttachmentSchema),
    /** Present only on a taken item; broadcasts and snapshots omit it like attachment payloads. */
    context: z.array(serverContextPartSchema).optional(),
    sendConfig: serverSendConfigSchema,
    state: z.enum(['pending', 'attempting', 'unknown', 'blocked', 'taken']),
});

const serverSessionSchema = z.object({
    sessionId: z.string().min(1),
    directory: z.string(),
    items: z.array(serverItemSchema),
    sendingId: z.string().nullable(),
});

const serverSnapshotSchema = z.object({
    revision: z.number(),
    sessions: z.array(serverSessionSchema),
});

const serverSessionResponseSchema = z.object({
    revision: z.number(),
    session: serverSessionSchema,
});

const serverTakeResponseSchema = serverSessionResponseSchema.extend({ item: serverItemSchema });
const serverTakeAllResponseSchema = serverSessionResponseSchema.extend({ items: z.array(serverItemSchema) });

type ServerQueueSession = z.infer<typeof serverSessionSchema>;
type ServerQueueItem = z.infer<typeof serverItemSchema>;
type ServerQueueAttachment = z.infer<typeof serverAttachmentSchema>;

const decodeDataUrl = (dataUrl: string): ArrayBuffer | null => {
    const commaIndex = dataUrl.indexOf(',');
    if (!dataUrl.startsWith('data:') || commaIndex === -1) return null;
    const meta = dataUrl.slice(5, commaIndex);
    const payload = dataUrl.slice(commaIndex + 1);
    try {
        if (meta.endsWith(';base64')) {
            const binary = atob(payload);
            const buffer = new ArrayBuffer(binary.length);
            const bytes = new Uint8Array(buffer);
            for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
            return buffer;
        }
        const encoded = new TextEncoder().encode(decodeURIComponent(payload));
        const buffer = new ArrayBuffer(encoded.byteLength);
        new Uint8Array(buffer).set(encoded);
        return buffer;
    } catch {
        return null;
    }
};

/** A taken item carries its payload; a projection item has an empty file. */
const toAttachedFile = (attachment: ServerQueueAttachment): AttachedFile => {
    const dataUrl = attachment.dataUrl ?? '';
    const bytes = dataUrl ? decodeDataUrl(dataUrl) : null;
    const file: AttachedFile = {
        id: attachment.id,
        file: new File(bytes ? [bytes] : [], attachment.filename, { type: attachment.mimeType }),
        dataUrl,
        mimeType: attachment.mimeType,
        filename: attachment.filename,
        size: attachment.size,
        source: attachment.source,
    };
    if (attachment.serverPath) file.serverPath = attachment.serverPath;
    return file;
};

const toQueuedMessage = (item: ServerQueueItem): QueuedMessage => {
    const message: QueuedMessage = {
        id: item.id,
        state: item.state,
        content: item.content,
        text: item.text,
        createdAt: item.createdAt,
        sendConfig: { ...item.sendConfig },
    };
    if (item.agentMention) message.agentMention = item.agentMention;
    if (item.attachments.length > 0) message.attachments = item.attachments.map(toAttachedFile);
    if (item.context) message.context = item.context;
    return message;
};

type ServerQueueAttachmentInput = Omit<ServerQueueAttachment, 'dataUrl'> & { dataUrl: string };

type ServerQueueItemInput = {
    content: string;
    text: string;
    agentMention?: string;
    attachments: ServerQueueAttachmentInput[];
    context: QueuedContextPart[];
    sendConfig: QueuedMessageSendConfig;
};

type ServerQueueRequestBody =
    | { directory: string; item: ServerQueueItemInput; requestId: string }
    | { itemIds: string[] }
    | { held: boolean };

const toServerAttachment = (attachment: AttachedFile): ServerQueueAttachmentInput => {
    const input: ServerQueueAttachmentInput = {
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.size,
        source: attachment.source,
        dataUrl: attachment.dataUrl,
    };
    if (attachment.serverPath) input.serverPath = attachment.serverPath;
    return input;
};

const toServerItemInput = (message: QueuedMessageInput, sendConfig: QueuedMessageSendConfig): ServerQueueItemInput => {
    const item: ServerQueueItemInput = {
        content: message.content,
        text: message.text ?? message.content,
        attachments: (message.attachments ?? []).filter((file) => Boolean(file.dataUrl)).map(toServerAttachment),
        context: message.context ?? [],
        sendConfig,
    };
    if (message.agentMention) item.agentMention = message.agentMention;
    return item;
};

export class QueueRequestError extends Error {
    constructor(readonly status: number) { super(`Message queue request failed (${status})`); }
}

const queueHealthSchema = z.object({
    healthy: z.literal(true),
    capabilities: z.object({
        messageQueue: z.union([z.literal(0), z.literal(1)]).optional(),
        displayAttribution: z.number().optional(),
        ordinaryCreateOnly: z.number().optional(),
    }).optional(),
});

const requireCurrentTarget = (target: MessageQueueTarget) => {
    if (target.runtimeKey !== getRuntimeKey()) throw new Error('Queue runtime changed');
};

export const checkQueueAdmission = async (target: MessageQueueTarget): Promise<void> => {
    requireCurrentTarget(target);
    const store = useMessageQueueStore.getState();
    const key = getMessageQueueKey(target);
    if (store.recoveryMessages[key]?.some((item) => item.state === 'unconfirmed')) throw new QueueRequestError(409);
    if (!isServerOwnedMessageQueue()) {
        const queues = store.queuedMessages;
        if ((queues[key]?.length ?? 0) >= MAX_MESSAGES_PER_QUEUE || (!queues[key] && Object.keys(queues).length >= MAX_QUEUE_TARGETS)) {
            throw new QueueRequestError(409);
        }
        const response = await opencodeClient.getScopedSdkClient(target.directory).global.health();
        const health = queueHealthSchema.parse(response.data);
        const capability = health.capabilities;
        if (capability?.messageQueue === 0 || (capability?.messageQueue !== 1
            && (capability?.displayAttribution === 1 || capability?.ordinaryCreateOnly === 1))) throw new QueueRequestError(501);
    } else {
        await requestJson(z.object({ supported: z.literal(true) }), `${sessionPath(target.sessionId)}/admission?directory=${encodeURIComponent(target.directory)}`);
    }
    requireCurrentTarget(target);
};

const requestJson = async <T,>(schema: z.ZodType<T>, path: string, init?: RequestInit): Promise<T> => {
    const response = await runtimeFetch(path, init);
    if (!response.ok) {
        throw new QueueRequestError(response.status);
    }
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) throw new Error('Invalid message queue response');
    return parsed.data;
};

const jsonInit = (method: string, body?: ServerQueueRequestBody): RequestInit => {
    if (body === undefined) return { method };
    return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
};

const sessionPath = (sessionId: string) => `/api/message-queue/sessions/${encodeURIComponent(sessionId)}`;

/**
 * Runtime keys whose queue the server owns, established by a successful
 * hydration. Their entries are a projection and must not be persisted: a
 * stale local copy would resurrect messages the server already delivered.
 */
const serverOwnedRuntimeKeys = new Set<string>();

/** Server revision last applied per queue key; older snapshots are ignored. */
const appliedRevisions = new Map<string, number>();
let hydrationGeneration = 0;

interface MessageQueueState {
    queuedMessages: Record<string, QueuedMessage[]>; // runtime + directory + session → queue
    quarantinedLegacyMessages: Record<string, QueuedMessage[]>;
    recoveryMessages: Record<string, QueuedMessage[]>;
    followUpBehavior: FollowUpBehavior;
    /**
     * Queued messages whose send is currently awaiting the server, per target.
     *
     * A queued item is removed only after its send resolves, so between
     * dispatch and resolution it is still visible to every other reader — and
     * a composer submit merges the whole queue into its own send. Over a relay
     * that window is seconds, long enough for the same message to be delivered
     * twice. Dispatchers must skip entries listed here.
     *
     * Never persisted: a restart has no in-flight sends, and a stale flag would
     * strand a queued message permanently. With a server-owned queue this
     * mirrors the server's in-flight item.
     */
    sendingIds: Record<string, string[]>;
}

interface MessageQueueActions {
    addToQueue: (target: MessageQueueTarget, message: QueuedMessageInput) => Promise<void>;
    recoverMessage: (target: MessageQueueTarget, messageId: string) => Promise<QueuedMessage>;
    forgetRecovery: (target: MessageQueueTarget, messageId: string) => Promise<void>;
    removeFromQueue: (target: MessageQueueTarget, messageId: string) => void;
    reorderQueue: (target: MessageQueueTarget, fromId: string, toId: string) => void;
    /** Removes the message and returns it in full, attachments included. */
    popToInput: (target: MessageQueueTarget, messageId: string) => Promise<QueuedMessage | null>;
    /**
     * Removes what the composer is about to send itself — one message or every
     * message not already being delivered — and returns it in full.
     */
    takeForSend: (target: MessageQueueTarget, messageId?: string) => Promise<QueuedMessage[]>;
    clearQueue: (target: MessageQueueTarget) => void;
    /** Drops the local projection only (the session is gone); never a server call. */
    forgetQueue: (target: MessageQueueTarget) => void;
    clearAllQueues: () => void;
    markSending: (target: MessageQueueTarget, messageId: string) => void;
    clearSending: (target: MessageQueueTarget, messageId: string) => void;
    getSendableQueue: (target: MessageQueueTarget) => QueuedMessage[];
    setFollowUpBehavior: (behavior: FollowUpBehavior) => void;
    getQueueForTarget: (target: MessageQueueTarget) => QueuedMessage[];
    /** Server-owned queue: load the authoritative queue for the active runtime. */
    hydrate: () => Promise<void>;
    /** Server-owned queue: apply one session's authoritative state (broadcast or response). */
    applyServerSession: (session: ServerQueueSession, revision: number, expectedRuntimeKey: string) => void;
    /** Server-owned queue: tell the server to hold or release a session's delivery. */
    setServerHold: (sessionId: string, held: boolean) => Promise<void>;
    resetForRuntimeSwitch: (previousRuntimeKey: string | null | undefined) => void;
}

type MessageQueueStore = MessageQueueState & MessageQueueActions;

/** Messages persisted before version 3 carried only `content`. */
type PersistedQueuedMessage = Omit<QueuedMessage, 'text'> & { text?: string };

type PersistedMessageQueueState = {
    queuedMessages?: Record<string, PersistedQueuedMessage[]>;
    quarantinedLegacyMessages?: Record<string, PersistedQueuedMessage[]>;
    recoveryMessages?: Record<string, PersistedQueuedMessage[]>;
    followUpBehavior?: FollowUpBehavior;
    queueModeEnabled?: boolean;
};

const withDeliveryText = (queues: Record<string, PersistedQueuedMessage[]>): Record<string, QueuedMessage[]> => (
    Object.fromEntries(Object.entries(queues).map(([key, queue]) => [
        key,
        queue.map((message) => ({ ...message, text: message.text ?? message.content })),
    ]))
);

export const migrateMessageQueueState = (persistedState: unknown, version: number): Partial<MessageQueueStore> => {
    const state = (persistedState ?? {}) as PersistedMessageQueueState;
    const legacyQueues = version < 2 ? (state.queuedMessages ?? {}) : {};
    const recoveryMessages = withDeliveryText(state.recoveryMessages ?? {});
    if (version >= 2) {
        for (const [key, items] of Object.entries(withDeliveryText(state.queuedMessages ?? {}))) {
            recoveryMessages[key] = [...(recoveryMessages[key] ?? []), ...items.map((item): QueuedMessage => ({ ...item, state: 'unconfirmed' }))];
        }
    }
    return {
        queuedMessages: {},
        quarantinedLegacyMessages: withDeliveryText({
            ...(state.quarantinedLegacyMessages ?? {}),
            ...legacyQueues,
        }),
        recoveryMessages,
        followUpBehavior: normalizeFollowUpBehavior(state.followUpBehavior, state.queueModeEnabled ?? null),
    };
};

const withoutKey = <T,>(record: Record<string, T>, key: string): Record<string, T> => {
    const { [key]: _removed, ...rest } = record;
    void _removed;
    return rest;
};

const removeMessageLocally = (
    state: Pick<MessageQueueState, 'queuedMessages'>,
    key: string,
    messageId: string,
): Pick<MessageQueueState, 'queuedMessages'> => {
    const newQueue = (state.queuedMessages[key] ?? []).filter((m) => m.id !== messageId);
    if (newQueue.length === 0) return { queuedMessages: withoutKey(state.queuedMessages, key) };
    return { queuedMessages: { ...state.queuedMessages, [key]: newQueue } };
};

/** Every projection of one session in this runtime, whatever directory it was keyed under. */
const clearSessionProjection = (
    state: Pick<MessageQueueState, 'queuedMessages' | 'sendingIds'>,
    runtimeKey: string,
    sessionId: string,
    revision: number,
): Pick<MessageQueueState, 'queuedMessages' | 'sendingIds'> => {
    let queuedMessages = state.queuedMessages;
    let sendingIds = state.sendingIds;
    for (const key of new Set([...Object.keys(queuedMessages), ...Object.keys(sendingIds)])) {
        const parsed = parseMessageQueueKey(key);
        if (parsed?.runtimeKey !== runtimeKey || parsed.sessionId !== sessionId) continue;
        if ((appliedRevisions.get(key) ?? -1) > revision) continue;
        appliedRevisions.set(key, revision);
        queuedMessages = withoutKey(queuedMessages, key);
        sendingIds = withoutKey(sendingIds, key);
    }
    return { queuedMessages, sendingIds };
};

export const useMessageQueueStore = create<MessageQueueStore>()(
    devtools(
        persist(
            (set, get) => {
                const applyServerSession = (session: ServerQueueSession, revision: number, expectedRuntimeKey: string) => {
                    if (expectedRuntimeKey !== getRuntimeKey()) return;
                    serverOwnedRuntimeKeys.add(expectedRuntimeKey);
                    const target = createMessageQueueTarget(session.sessionId, session.directory, expectedRuntimeKey);
                    if (!target) {
                        // Servers before 1.22.2 drop a session's directory once its
                        // queue is empty. A session id is unique across directories,
                        // so an empty session still says which projection is done.
                        if (session.items.length > 0) return;
                        set((state) => clearSessionProjection(state, expectedRuntimeKey, session.sessionId, revision));
                        return;
                    }
                    const key = getMessageQueueKey(target);
                    if ((appliedRevisions.get(key) ?? -1) > revision) return;
                    appliedRevisions.set(key, revision);
                    set((state) => {
                        const items = session.items.map(toQueuedMessage);
                        const queue = items.filter((item) => item.state === 'pending' || item.state === 'attempting');
                        const recovery = items.filter((item) => item.state !== 'pending' && item.state !== 'attempting');
                        const unresolved = (state.recoveryMessages[key] ?? []).filter((item) => item.state === 'unconfirmed' && !items.some((serverItem) => serverItem.id === item.id));
                        const recoveryMessages = { ...state.recoveryMessages, [key]: [...unresolved, ...recovery] };
                        const queuedMessages = queue.length > 0
                            ? { ...state.queuedMessages, [key]: queue }
                            : withoutKey(state.queuedMessages, key);
                        const sendingIds = session.sendingId
                            ? { ...state.sendingIds, [key]: [session.sendingId] }
                            : withoutKey(state.sendingIds, key);
                        return { queuedMessages, sendingIds, recoveryMessages };
                    });
                };

                /** Server state wins; a failed round-trip re-reads it instead of guessing. */
                const refreshSession = async (target: MessageQueueTarget) => {
                    try {
                        requireCurrentTarget(target);
                        const snapshot = await requestJson(serverSnapshotSchema, '/api/message-queue');
                        const session = snapshot.sessions.find((entry) => entry.sessionId === target.sessionId)
                            ?? { sessionId: target.sessionId, directory: target.directory, items: [], sendingId: null };
                        applyServerSession(session, snapshot.revision, target.runtimeKey);
                        return session;
                    } catch {
                        return null;
                    }
                };

                const serverMutation = async (
                    target: MessageQueueTarget,
                    path: string,
                    init: RequestInit,
                ) => {
                    try {
                        requireCurrentTarget(target);
                        const result = await requestJson(serverSessionResponseSchema, path, init);
                        applyServerSession(result.session, result.revision, target.runtimeKey);
                    } catch {
                        console.warn('[queue] server update failed');
                        await refreshSession(target);
                    }
                };

                return {
                    queuedMessages: {},
                    quarantinedLegacyMessages: {},
                    recoveryMessages: {},
                    followUpBehavior: DEFAULT_FOLLOW_UP_BEHAVIOR,
                    sendingIds: {},

                    addToQueue: async (target, message) => {
                        const key = getMessageQueueKey(target);
                        if (isServerOwnedMessageQueue()) requireCurrentTarget(target);
                        else await checkQueueAdmission(target);
                        const id = `queued-${crypto.randomUUID()}`;
                        const queuedMessage: QueuedMessage = {
                            id,
                            state: 'pending',
                            content: message.content,
                            text: message.text ?? message.content,
                            createdAt: Date.now(),
                            sendConfig: message.sendConfig,
                        };
                        if (message.agentMention) queuedMessage.agentMention = message.agentMention;
                        if (message.attachments && message.attachments.length > 0) queuedMessage.attachments = message.attachments;
                        if (message.context && message.context.length > 0) queuedMessage.context = message.context;

                        if (!isServerOwnedMessageQueue()) {
                            // Recheck after health. Capacity never discards accepted work.
                            set((state) => {
                                const current = state.queuedMessages[key] ?? [];
                                if (current.length >= MAX_MESSAGES_PER_QUEUE || (!state.queuedMessages[key] && Object.keys(state.queuedMessages).length >= MAX_QUEUE_TARGETS)) throw new QueueRequestError(409);
                                return { queuedMessages: { ...state.queuedMessages, [key]: [...current, queuedMessage] } };
                            });
                            return;
                        }
                        if (!message.sendConfig) throw new Error('A queued message needs a provider and model to be delivered later.');
                        if (get().recoveryMessages[key]?.some((item) => item.state === 'unconfirmed')) throw new QueueRequestError(409);
                        const historyIdentity = createInputHistoryIdentity(target.runtimeKey, target.directory, target.sessionId);
                        const historySubmission = createInputHistorySubmission(message.content, message.attachments ?? []);
                        try {
                            const result = await requestJson(serverSessionResponseSchema, `${sessionPath(target.sessionId)}/items`, jsonInit('POST', {
                                directory: target.directory,
                                item: toServerItemInput(message, message.sendConfig),
                                requestId: id,
                            }));
                            applyServerSession(result.session, result.revision, target.runtimeKey);
                            serverOwnedRuntimeKeys.add(target.runtimeKey);
                            if (historyIdentity) {
                                useInputHistoryStore.getState().appendSubmissions(historyIdentity, [historySubmission]);
                            }
                        } catch (error) {
                            // Only an explicit pre-admission refusal proves no intake.
                            if (!(error instanceof QueueRequestError && [400, 401, 403, 409, 501].includes(error.status))) {
                                set((state) => ({ recoveryMessages: { ...state.recoveryMessages,
                                    [key]: [...(state.recoveryMessages[key] ?? []), { ...queuedMessage, state: 'unconfirmed' }],
                                } }));
                                const reconciled = target.runtimeKey === getRuntimeKey() ? await refreshSession(target) : null;
                                if (reconciled?.items.some((item) => item.id === id)) {
                                    if (historyIdentity) useInputHistoryStore.getState().appendSubmissions(historyIdentity, [historySubmission]);
                                    return;
                                }
                            }
                            throw error;
                        }
                    },

                    recoverMessage: async (target, messageId) => {
                        const local = get().recoveryMessages[getMessageQueueKey(target)]?.find((item) => item.id === messageId);
                        if (local?.state === 'unconfirmed' || !isServerOwnedMessageQueue()) {
                            if (!local) throw new Error('Queue recovery record is missing');
                            return local;
                        }
                        requireCurrentTarget(target);
                        const result = await requestJson(serverTakeResponseSchema, `${sessionPath(target.sessionId)}/items/${encodeURIComponent(messageId)}`);
                        return toQueuedMessage(result.item);
                    },

                    forgetRecovery: async (target, messageId) => {
                        requireCurrentTarget(target);
                        const result = isServerOwnedMessageQueue() ? await requestJson(serverSessionResponseSchema, `${sessionPath(target.sessionId)}/items/${encodeURIComponent(messageId)}`, jsonInit('DELETE')) : null;
                        const key = getMessageQueueKey(target);
                        set((state) => ({ recoveryMessages: { ...state.recoveryMessages, [key]: (state.recoveryMessages[key] ?? []).filter((item) => item.id !== messageId) } }));
                        if (result) applyServerSession(result.session, result.revision, target.runtimeKey);
                    },

                    removeFromQueue: (target, messageId) => {
                        const key = getMessageQueueKey(target);
                        set((state) => removeMessageLocally(state, key, messageId));
                        if (isServerOwnedMessageQueue()) {
                            void serverMutation(target, `${sessionPath(target.sessionId)}/items/${encodeURIComponent(messageId)}`, jsonInit('DELETE'));
                        }
                    },

                    reorderQueue: (target, fromId, toId) => {
                        if (fromId === toId) return;
                        const key = getMessageQueueKey(target);
                        const currentQueue = get().queuedMessages[key];
                        if (!currentQueue) return;
                        const fromIndex = currentQueue.findIndex((m) => m.id === fromId);
                        const toIndex = currentQueue.findIndex((m) => m.id === toId);
                        if (fromIndex === -1 || toIndex === -1) return;

                        const newQueue = currentQueue.slice();
                        const [moved] = newQueue.splice(fromIndex, 1);
                        newQueue.splice(toIndex, 0, moved);

                        set((state) => ({
                            queuedMessages: {
                                ...state.queuedMessages,
                                [key]: newQueue,
                            },
                        }));
                        if (isServerOwnedMessageQueue()) {
                            const itemIds = newQueue.map((message) => message.id);
                            void serverMutation(target, `${sessionPath(target.sessionId)}/order`, jsonInit('PUT', { itemIds }));
                        }
                    },

                    popToInput: async (target, messageId) => {
                        const [message] = await get().takeForSend(target, messageId);
                        if (!message) return null;
                        const key = getMessageQueueKey(target);
                        // Retain the full accepted transfer under its origin even
                        // when navigation makes editor publication inappropriate.
                        set(state => ({
                            ...removeMessageLocally(state, key, message.id),
                            recoveryMessages: { ...state.recoveryMessages, [key]: [
                                ...(state.recoveryMessages[key] ?? []).filter(item => item.id !== message.id),
                                { ...message, state: 'taken' },
                            ] },
                        }));
                        return message;
                    },

                    takeForSend: async (target, messageId) => {
                        const key = getMessageQueueKey(target);
                        requireCurrentTarget(target);
                        if (isServerOwnedMessageQueue()) {
                            const scope = captureRuntimeRequestScope();
                            if (messageId) {
                                const result = await requestJson(
                                    serverTakeResponseSchema,
                                    `${sessionPath(target.sessionId)}/items/${encodeURIComponent(messageId)}/take`,
                                    jsonInit('POST'),
                                );
                                if (isRuntimeRequestScopeCurrent(scope)) applyServerSession(result.session, result.revision, target.runtimeKey);
                                return [toQueuedMessage(result.item)];
                            }
                            const result = await requestJson(serverTakeAllResponseSchema, `${sessionPath(target.sessionId)}/take`, jsonInit('POST'));
                            if (isRuntimeRequestScopeCurrent(scope)) applyServerSession(result.session, result.revision, target.runtimeKey);
                            return result.items.map(toQueuedMessage);
                        }

                        const state = get();
                        const sending = state.sendingIds[key] ?? [];
                        const taken = (state.queuedMessages[key] ?? []).filter((message) => (
                            (messageId ? message.id === messageId : true) && (!message.state || message.state === 'pending') && !sending.includes(message.id)
                        ));
                        if (taken.length === 0) return [];
                        const takenIds = new Set(taken.map((message) => message.id));
                        set((prevState) => {
                            const remaining = (prevState.queuedMessages[key] ?? []).filter((message) => !takenIds.has(message.id));
                            if (remaining.length === 0) return { queuedMessages: withoutKey(prevState.queuedMessages, key) };
                            return { queuedMessages: { ...prevState.queuedMessages, [key]: remaining } };
                        });
                        return taken;
                    },

                    clearQueue: (target) => {
                        const key = getMessageQueueKey(target);
                        set((state) => {
                            // Clearing drops what is still queued, never a message
                            // already handed to the server: that send will resolve
                            // and must find its entry to remove or restore.
                            const sending = state.sendingIds[key] ?? [];
                            const retained = (state.queuedMessages[key] ?? []).filter((m) => sending.includes(m.id));
                            if (retained.length > 0) {
                                return { queuedMessages: { ...state.queuedMessages, [key]: retained } };
                            }
                            return { queuedMessages: withoutKey(state.queuedMessages, key) };
                        });
                        if (isServerOwnedMessageQueue()) {
                            void serverMutation(target, sessionPath(target.sessionId), jsonInit('DELETE'));
                        }
                    },

                    forgetQueue: (target) => {
                        const key = getMessageQueueKey(target);
                        appliedRevisions.delete(key);
                        set((state) => ({
                            queuedMessages: withoutKey(state.queuedMessages, key),
                            sendingIds: withoutKey(state.sendingIds, key),
                        }));
                    },

                    clearAllQueues: () => {
                        set({ queuedMessages: {}, sendingIds: {} });
                    },

                    markSending: (target, messageId) => {
                        const key = getMessageQueueKey(target);
                        set((state) => {
                            const current = state.sendingIds[key] ?? [];
                            if (current.includes(messageId)) return state;
                            return {
                                queuedMessages: { ...state.queuedMessages, [key]: (state.queuedMessages[key] ?? []).map(item => item.id === messageId ? { ...item, state: 'attempting' } : item) },
                                sendingIds: { ...state.sendingIds, [key]: [...current, messageId] },
                            };
                        });
                    },

                    clearSending: (target, messageId) => {
                        const key = getMessageQueueKey(target);
                        set((state) => {
                            const current = state.sendingIds[key];
                            if (!current || !current.includes(messageId)) return state;
                            const next = current.filter((id) => id !== messageId);
                            const unsettled = (state.queuedMessages[key] ?? []).find(item => item.id === messageId && item.state === 'attempting');
                            const update: Partial<MessageQueueState> = {
                                sendingIds: next.length ? { ...state.sendingIds, [key]: next } : withoutKey(state.sendingIds, key),
                            };
                            if (unsettled) {
                                update.queuedMessages = removeMessageLocally(state, key, messageId).queuedMessages;
                                update.recoveryMessages = { ...state.recoveryMessages, [key]: [...(state.recoveryMessages[key] ?? []), { ...unsettled, state: 'unknown' }] };
                            }
                            return update;
                        });
                    },

                    getSendableQueue: (target) => {
                        const key = getMessageQueueKey(target);
                        const state = get();
                        const queue = state.queuedMessages[key] ?? [];
                        const sending = state.sendingIds[key] ?? [];
                        return queue.filter((message) => (!message.state || message.state === 'pending') && !sending.includes(message.id));
                    },

                    setFollowUpBehavior: (behavior) => {
                        set({ followUpBehavior: behavior });
                        void updateDesktopSettings({ followUpBehavior: behavior });
                    },

                    getQueueForTarget: (target) => {
                        return get().queuedMessages[getMessageQueueKey(target)] ?? [];
                    },

                    hydrate: async () => {
                        if (!isServerOwnedMessageQueue()) return;
                        const runtimeKey = getRuntimeKey();
                        const generation = ++hydrationGeneration;
                        const isCurrent = () => generation === hydrationGeneration && runtimeKey === getRuntimeKey();

                        // A legacy browser item may already have been attempted.
                        // Retain it for review; reconnect never creates new intake.
                        const legacyEntries = Object.entries(get().queuedMessages)
                            .map(([key, queue]) => ({ target: parseMessageQueueKey(key), queue }))
                            .filter((entry): entry is { target: MessageQueueTarget; queue: QueuedMessage[] } => (
                                entry.target !== null && entry.target.runtimeKey === runtimeKey && !serverOwnedRuntimeKeys.has(runtimeKey)
                            ));
                        for (const { target, queue } of legacyEntries) {
                            const key = getMessageQueueKey(target);
                            set((state) => {
                                const retained = state.recoveryMessages[key] ?? [];
                                return { recoveryMessages: { ...state.recoveryMessages, [key]: [...retained,
                                    ...queue.filter((item) => !retained.some((saved) => saved.id === item.id)).map((item): QueuedMessage => ({ ...item, state: 'unconfirmed' })),
                                ] } };
                            });
                        }

                        const snapshot = await requestJson(serverSnapshotSchema, '/api/message-queue');
                        if (!isCurrent()) return;
                        serverOwnedRuntimeKeys.add(runtimeKey);
                        set((state) => {
                            const queuedMessages = { ...state.queuedMessages };
                            const sendingIds = { ...state.sendingIds };
                            const recoveryMessages = { ...state.recoveryMessages };
                            // Reconcile all known keys, including sessions absent
                            // from this snapshot. Newer per-session state wins whole.
                            const keys = new Set([...Object.keys(queuedMessages), ...Object.keys(sendingIds), ...Object.keys(recoveryMessages), ...appliedRevisions.keys()]);
                            for (const key of keys) {
                                if (parseMessageQueueKey(key)?.runtimeKey !== runtimeKey || (appliedRevisions.get(key) ?? -1) > snapshot.revision) continue;
                                delete queuedMessages[key];
                                delete sendingIds[key];
                                recoveryMessages[key] = (recoveryMessages[key] ?? []).filter(item => item.state === 'unconfirmed');
                                appliedRevisions.set(key, snapshot.revision);
                            }
                            for (const session of snapshot.sessions) {
                                const target = createMessageQueueTarget(session.sessionId, session.directory, runtimeKey);
                                if (!target) continue;
                                const key = getMessageQueueKey(target);
                                if ((appliedRevisions.get(key) ?? -1) > snapshot.revision) continue;
                                appliedRevisions.set(key, snapshot.revision);
                                const items = session.items.map(toQueuedMessage);
                                const pending = items.filter((item) => item.state === 'pending' || item.state === 'attempting');
                                if (pending.length > 0) queuedMessages[key] = pending;
                                recoveryMessages[key] = [
                                    ...(state.recoveryMessages[key] ?? []).filter((item) => item.state === 'unconfirmed' && !items.some((saved) => saved.id === item.id)),
                                    ...items.filter((item) => item.state !== 'pending' && item.state !== 'attempting'),
                                ];
                                if (session.sendingId) sendingIds[key] = [session.sendingId];
                            }
                            return { queuedMessages, sendingIds, recoveryMessages };
                        });
                    },

                    applyServerSession,

                    setServerHold: async (sessionId, held) => {
                        if (!isServerOwnedMessageQueue()) return;
                        const response = await runtimeFetch(`${sessionPath(sessionId)}/hold`, jsonInit('PUT', { held }));
                        if (!response.ok) throw new Error(`Message queue hold request failed (${response.status})`);
                    },

                    resetForRuntimeSwitch: (previousRuntimeKey) => {
                        hydrationGeneration += 1;
                        if (!previousRuntimeKey || !serverOwnedRuntimeKeys.has(previousRuntimeKey)) return;
                        // The previous runtime's projection belongs to its server;
                        // switching back re-hydrates it from there.
                        set((state) => {
                            const queuedMessages: Record<string, QueuedMessage[]> = {};
                            const sendingIds: Record<string, string[]> = {};
                            for (const [key, queue] of Object.entries(state.queuedMessages)) {
                                if (parseMessageQueueKey(key)?.runtimeKey === previousRuntimeKey) appliedRevisions.delete(key);
                                else queuedMessages[key] = queue;
                            }
                            for (const [key, ids] of Object.entries(state.sendingIds)) {
                                if (parseMessageQueueKey(key)?.runtimeKey !== previousRuntimeKey) sendingIds[key] = ids;
                            }
                            return { queuedMessages, sendingIds };
                        });
                    },
                };
            },
            {
                name: 'message-queue-store',
                version: 4,
                storage: createDeferredSafeJSONStorage(),
                partialize: (state) => ({
                    // Foreground-only queues cannot prove crash-time attempt
                    // ordering. Reload retains payloads for review, never replay.
                    queuedMessages: {},
                    quarantinedLegacyMessages: state.quarantinedLegacyMessages,
                    recoveryMessages: {
                        ...state.recoveryMessages,
                        ...Object.fromEntries(Object.entries(state.queuedMessages)
                            .filter(([key]) => !serverOwnedRuntimeKeys.has(parseMessageQueueKey(key)?.runtimeKey ?? ''))
                            .map(([key, items]) => [key, [
                                ...(state.recoveryMessages[key] ?? []),
                                ...items.map(item => ({ ...item, state: 'unconfirmed' })),
                            ]])),
                    },
                    followUpBehavior: state.followUpBehavior,
                }),
                migrate: migrateMessageQueueState,
            }
        ),
        {
            name: 'message-queue-store',
        }
    )
);

const serverUpdatedEventSchema = z.object({
    properties: z.object({ revision: z.number(), session: serverSessionSchema }),
});

export type MessageQueueUpdatedEvent = {
    type: 'openchamber:message-queue.updated';
    properties: z.infer<typeof serverUpdatedEventSchema>['properties'];
};

/** `openchamber:message-queue.updated` broadcast → projection. */
export const applyMessageQueueUpdatedEvent = (payload: Event | MessageQueueUpdatedEvent, expectedRuntimeKey: string): void => {
    if (!isServerOwnedMessageQueue()) return;
    const parsed = serverUpdatedEventSchema.safeParse(payload);
    if (!parsed.success) return;
    const { session, revision } = parsed.data.properties;
    useMessageQueueStore.getState().applyServerSession(session, revision, expectedRuntimeKey);
};
