import type { Message, Session } from '@opencode-ai/sdk/v2/client';
import { z } from 'zod';
import { opencodeClient } from '@/lib/opencode/client';
import { renderMagicPrompt } from '@/lib/magicPrompts';
import { flattenAssistantTextParts } from '@/lib/messages/messageText';
import {
  classifyPersistedAgentBackend,
  classifyRequestedAgentBackend,
  getOriginalSessionID,
  getReviewSessionID,
  isReviewSession,
  withReviewSessionMarker,
} from '@/lib/sessionReviewMetadata';
import type { SessionMetadataRecord } from '@/lib/sessionReviewMetadata';
import { useConfigStore } from '@/stores/useConfigStore';
import { useAutoReviewStore, type AutoReviewRun } from '@/stores/useAutoReviewStore';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useUIStore } from '@/stores/useUIStore';
import {
  BoundSessionOperationError,
  bindSessionOperation,
  finalizeConfirmedSessionDeletion,
  optimisticSend,
  waitForConnectionOrThrow,
} from '@/sync/session-actions';
import type { BoundSessionOperation } from '@/sync/session-actions';
import { withSessionSendPreflight } from '@/sync/session-send-preflight';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getAllSyncSessionMap, getSyncMessages, getSyncParts, getSyncSessionStatus, registerSessionDirectory } from '@/sync/sync-refs';
import { markPendingUserSendAnimation } from '@/lib/userSendAnimation';
import { getRuntimeKey, getRuntimeTransportEpoch } from '@/lib/runtime-switch';
import { RetainedSessionError } from '@/lib/retainedSessionError';
import type { RetainedSessionRecovery } from '@/lib/retainedSessionError';

const HANDOFF_TIMEOUT_MS = 180_000;
const HANDOFF_POLL_MS = 400;
const AUTO_REVIEW_POLL_MS = 300;
const AUTO_REVIEW_MAX_ITERATIONS = 15;
const AUTO_REVIEW_FINAL_MARKER = 'FINAL_REVIEW_STATUS: no_remaining_findings';
const AUTO_REVIEW_FINAL_MARKER_NORMALIZED = AUTO_REVIEW_FINAL_MARKER.toLowerCase();
const activeAutoReviewLoops = new Set<string>();
const activeAutoReviewForwardKeys = new Set<string>();

type SessionModelContext = {
  providerID: string;
  modelID: string;
  agent?: string;
  variant?: string;
};

type StartReviewFlowInput = SessionModelContext & {
  originalSessionID: string;
  directory: string;
  agentMentionName?: string;
  generateHandoff?: boolean;
  returnAfterHandoffRequest?: boolean;
  autoReview?: boolean;
};

type AssistantTextMessage = {
  id: string;
  text: string;
};

const isMessageCompleted = (message: Message): boolean => {
  const finish = (message as { finish?: unknown }).finish;
  if (typeof finish === 'string' && finish.length > 0) return true;
  const completed = (message as { time?: { completed?: unknown } }).time?.completed;
  return typeof completed === 'number' && completed > 0;
};

const getMessageCreatedAt = (message: Message): number => {
  const created = (message as { time?: { created?: unknown } }).time?.created;
  return typeof created === 'number' && Number.isFinite(created) ? created : 0;
};

const getMessageRole = (message: Message): string => {
  const role = (message as { role?: unknown }).role;
  return typeof role === 'string' ? role : '';
};

const getMessageParentID = (message: Message): string | null => {
  const parentID = (message as { parentID?: unknown }).parentID;
  return typeof parentID === 'string' && parentID.trim().length > 0 ? parentID : null;
};

const isCompactionCommandMessage = (message: Message, directory: string): boolean => {
  const parts = getSyncParts(message.id, directory);
  return parts.some((part) => {
    const type = (part as { type?: unknown }).type;
    if (type === 'compaction') return true;
    if (type !== 'text') return false;
    const text = (part as { text?: unknown }).text;
    return typeof text === 'string' && text.trim() === '/compact';
  });
};

const getLatestAssistantTextMessage = (
  sessionID: string,
  directory: string,
  lastForwardedMessageID?: string,
  afterCreatedAt = 0,
  expectedParentID?: string,
): AssistantTextMessage | null => {
  const messages = getSyncMessages(sessionID, directory);
  const compactionCommandIDs = new Set<string>();
  for (const message of messages) {
    if (isCompactionCommandMessage(message, directory)) {
      compactionCommandIDs.add(message.id);
    }
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.id === lastForwardedMessageID) return null;
    if (getMessageRole(message) !== 'assistant') continue;
    if (!isMessageCompleted(message)) continue;
    if (getMessageCreatedAt(message) < afterCreatedAt - 1000) continue;
    const parentID = getMessageParentID(message);
    if (!isExpectedAutoReviewAssistantParent(message, expectedParentID)) continue;
    if (parentID && compactionCommandIDs.has(parentID)) continue;
    const text = flattenAssistantTextParts(getSyncParts(message.id, directory)).trim();
    if (!text) continue;
    return { id: message.id, text };
  }

  return null;
};

const isSessionIdle = (sessionID: string, directory: string): boolean => {
  const status = getSyncSessionStatus(sessionID, directory);
  return status?.type === 'idle';
};

export const isAutoReviewRuntimeCurrent = (runtimeKey: string): boolean => runtimeKey === getRuntimeKey();

const stopRunForRuntimeMismatch = (run: AutoReviewRun): void => {
  useAutoReviewStore.getState().updateRun(run.originalSessionID, (current) => ({
    ...current,
    status: 'stopped',
    error: 'Auto-review stopped because the runtime changed.',
  }));
};

export const assertAutoReviewRuntimeStillCurrent = (expectedRuntimeKey?: string): void => {
  if (expectedRuntimeKey && !isAutoReviewRuntimeCurrent(expectedRuntimeKey)) {
    throw new Error('Auto-review stopped because the runtime changed.');
  }
};

const isRuntimeChangeError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('runtime changed');
};

export const hasFinalReviewMarker = (text: string): boolean => {
  const lines = text.trim().split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.at(-1)?.toLowerCase() === AUTO_REVIEW_FINAL_MARKER_NORMALIZED;
};

export const stripFinalReviewMarker = (text: string): string => {
  const lines = text.trimEnd().split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.at(-1)?.trim().toLowerCase() === AUTO_REVIEW_FINAL_MARKER_NORMALIZED) {
    lines.pop();
  }
  return lines.join('\n').trim();
};

export const isExpectedAutoReviewAssistantParent = (message: Message, expectedParentID?: string): boolean => {
  if (!expectedParentID) return true;
  return getMessageParentID(message) === expectedParentID;
};

const getAutoReviewForwardKey = (run: AutoReviewRun, messageID: string): string => [
  run.runtimeKey,
  run.originalSessionID,
  run.phase,
  run.expectedAssistantParentID ?? '',
  messageID,
].join(':');

export const claimAutoReviewForward = (run: AutoReviewRun, messageID: string): string | null => {
  const key = getAutoReviewForwardKey(run, messageID);
  if (activeAutoReviewForwardKeys.has(key)) return null;
  activeAutoReviewForwardKeys.add(key);
  return key;
};

export const releaseAutoReviewForward = (key: string): void => {
  activeAutoReviewForwardKeys.delete(key);
};

const autoReviewReviewerInstructions = (): Array<{ text: string; synthetic: true }> => [{
  synthetic: true,
  text: `This review is part of an automatic review loop. If there are no remaining issues, end your response with this exact final line:\n${AUTO_REVIEW_FINAL_MARKER}\nIf you found issues that require changes, do not include that final status line.`,
}];

const runAutoReviewLoop = async (originalSessionID: string): Promise<void> => {
  while (true) {
    const run = useAutoReviewStore.getState().runsByOriginalSessionID[originalSessionID];
    if (!run || run.status !== 'running') return;
    if (!isAutoReviewRuntimeCurrent(run.runtimeKey)) {
      stopRunForRuntimeMismatch(run);
      return;
    }

    const sourceSessionID = run.phase === 'waiting_for_reviewer' ? run.reviewSessionID : run.originalSessionID;
    const sourceDirectory = requireLinkedSessionDirectory(sourceSessionID, run.runtimeKey, 'Auto-review session');
    if (!isSessionIdle(sourceSessionID, sourceDirectory)) {
      await new Promise((resolve) => setTimeout(resolve, AUTO_REVIEW_POLL_MS));
      continue;
    }

    const latest = getLatestAssistantTextMessage(
      sourceSessionID,
      sourceDirectory,
      run.lastForwardedMessageID,
      run.waitAfterCreatedAt,
      run.expectedAssistantParentID,
    );
    if (!latest) {
      await new Promise((resolve) => setTimeout(resolve, AUTO_REVIEW_POLL_MS));
      continue;
    }

    if (run.phase === 'waiting_for_reviewer') {
      const forwardKey = claimAutoReviewForward(run, latest.id);
      if (!forwardKey) {
        await new Promise((resolve) => setTimeout(resolve, AUTO_REVIEW_POLL_MS));
        continue;
      }
      if (!isAutoReviewRuntimeCurrent(run.runtimeKey)) {
        releaseAutoReviewForward(forwardKey);
        stopRunForRuntimeMismatch(run);
        return;
      }
      try {
        const waitAfterCreatedAt = Date.now();
        const isFinalReview = hasFinalReviewMarker(latest.text);
        const reviewFeedback = isFinalReview ? stripFinalReviewMarker(latest.text) : latest.text;
        const sentMessageID = await sendReviewFeedbackToOriginal(run.reviewSessionID, sourceDirectory, reviewFeedback, run.runtimeKey);
        if (isFinalReview) {
          useAutoReviewStore.getState().completeRun(run.originalSessionID);
          return;
        }
        useAutoReviewStore.getState().updateRun(run.originalSessionID, (current) => ({
          ...current,
          phase: 'waiting_for_implementer',
          lastForwardedMessageID: latest.id,
          expectedAssistantParentID: sentMessageID,
          waitAfterCreatedAt,
        }));
      } finally {
        releaseAutoReviewForward(forwardKey);
      }
    } else {
      if (run.iteration >= run.maxIterations) {
        useAutoReviewStore.getState().stopRun(run.originalSessionID);
        return;
      }
      const forwardKey = claimAutoReviewForward(run, latest.id);
      if (!forwardKey) {
        await new Promise((resolve) => setTimeout(resolve, AUTO_REVIEW_POLL_MS));
        continue;
      }
      if (!isAutoReviewRuntimeCurrent(run.runtimeKey)) {
        releaseAutoReviewForward(forwardKey);
        stopRunForRuntimeMismatch(run);
        return;
      }
      try {
        const waitAfterCreatedAt = Date.now();
        const sentMessageID = await sendImplementationResponseToReviewer(run.originalSessionID, sourceDirectory, latest.text, true, run.runtimeKey);
        useAutoReviewStore.getState().updateRun(run.originalSessionID, (current) => ({
          ...current,
          phase: 'waiting_for_reviewer',
          iteration: current.iteration + 1,
          lastForwardedMessageID: latest.id,
          expectedAssistantParentID: sentMessageID,
          waitAfterCreatedAt,
        }));
      } finally {
        releaseAutoReviewForward(forwardKey);
      }
    }
  }
};

const startAutoReviewRun = (run: AutoReviewRun): void => {
  useAutoReviewStore.getState().upsertRun(run);
  resumeAutoReviewRun(run.originalSessionID);
};

export const resumeAutoReviewRun = (originalSessionID: string): void => {
  const run = useAutoReviewStore.getState().runsByOriginalSessionID[originalSessionID];
  if (!run || run.status !== 'running' || !isAutoReviewRuntimeCurrent(run.runtimeKey) || activeAutoReviewLoops.has(originalSessionID)) return;
  activeAutoReviewLoops.add(originalSessionID);
  void runAutoReviewLoop(run.originalSessionID).catch((error) => {
    console.error('[review-flow] auto-review loop failed', error);
    useAutoReviewStore.getState().updateRun(run.originalSessionID, (current) => ({
      ...current,
      status: isRuntimeChangeError(error) ? 'stopped' : 'error',
      error: error instanceof Error ? error.message : String(error),
    }));
  }).finally(() => {
    activeAutoReviewLoops.delete(originalSessionID);
  });
};

const waitForAssistantText = async (sessionID: string, directory: string, afterCreatedAt: number): Promise<string> => {
  const deadline = Date.now() + HANDOFF_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const messages = getSyncMessages(sessionID, directory);
    const candidates = messages
      .filter((message) => getMessageRole(message) === 'assistant')
      .filter((message) => getMessageCreatedAt(message) >= afterCreatedAt - 1000)
      .filter(isMessageCompleted)
      .sort((left, right) => getMessageCreatedAt(right) - getMessageCreatedAt(left));

    for (const message of candidates) {
      const text = flattenAssistantTextParts(getSyncParts(message.id, directory)).trim();
      if (text) return text;
    }

    await new Promise((resolve) => setTimeout(resolve, HANDOFF_POLL_MS));
  }
  throw new Error('Timed out waiting for handoff response');
};

const resolveModelContext = (sessionID: string): SessionModelContext | null => {
  const selection = useSelectionStore.getState();
  const config = useConfigStore.getState();
  const lastChoice = useSessionUIStore.getState().getLastUserChoice(sessionID);
  const agent = lastChoice?.agent || selection.getSessionAgentSelection(sessionID) || config.currentAgentName || undefined;
  const sessionModel = selection.getSessionModelSelection(sessionID);
  const agentModel = agent ? selection.getAgentModelForSession(sessionID, agent) : null;
  const lastChoiceModel = lastChoice?.providerID && lastChoice.modelID
    ? { providerId: lastChoice.providerID, modelId: lastChoice.modelID }
    : null;
  const selectedModel = lastChoiceModel || agentModel || sessionModel || (config.currentProviderId && config.currentModelId
    ? { providerId: config.currentProviderId, modelId: config.currentModelId }
    : null);
  if (!selectedModel?.providerId || !selectedModel?.modelId) return null;
  if (lastChoiceModel) {
    return {
      providerID: lastChoiceModel.providerId,
      modelID: lastChoiceModel.modelId,
      agent,
      variant: lastChoice?.variant,
    };
  }
  // Variants are model-specific; only reuse one resolved for the same model.
  const selectionVariant = agent
    ? selection.getAgentModelVariantForSession(sessionID, agent, selectedModel.providerId, selectedModel.modelId)
    : undefined;
  const configVariant = config.currentProviderId === selectedModel.providerId && config.currentModelId === selectedModel.modelId
    ? config.currentVariant
    : undefined;
  return {
    providerID: selectedModel.providerId,
    modelID: selectedModel.modelId,
    agent,
    variant: selectionVariant || configVariant || undefined,
  };
};

const sendPlainMessage = async (
  sessionID: string,
  directory: string,
  text: string,
  modelContext?: SessionModelContext | null,
  additionalParts?: Array<{ text: string; synthetic?: boolean }>,
  expectedRuntimeKey?: string,
): Promise<string> => {
  assertAutoReviewRuntimeStillCurrent(expectedRuntimeKey);
  const resolved = modelContext ?? resolveModelContext(sessionID);
  if (!resolved) throw new Error('Select a model before sending review flow messages');
  const selection = useSelectionStore.getState();
  selection.saveSessionModelSelection(sessionID, resolved.providerID, resolved.modelID);
  if (resolved.agent) {
    selection.saveSessionAgentSelection(sessionID, resolved.agent);
    selection.saveAgentModelForSession(sessionID, resolved.agent, resolved.providerID, resolved.modelID);
    selection.saveAgentModelVariantForSession(sessionID, resolved.agent, resolved.providerID, resolved.modelID, resolved.variant);
  }
  markPendingUserSendAnimation(sessionID);
  let sentMessageID: string | null = null;
  await optimisticSend({
    sessionId: sessionID,
    content: text,
    directory,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    agent: resolved.agent,
    onMessageID: (messageID) => {
      sentMessageID = messageID;
    },
    beforeOptimisticInsert: () => assertAutoReviewRuntimeStillCurrent(expectedRuntimeKey),
    onOptimisticInsert: () => requestChatForceScrollBottom(sessionID),
    send: (messageID) => {
      assertAutoReviewRuntimeStillCurrent(expectedRuntimeKey);
      return withSessionSendPreflight({
        sessionId: sessionID,
        directory,
        providerID: resolved.providerID,
      }, () => opencodeClient.sendMessage({
        id: sessionID,
        directory,
        providerID: resolved.providerID,
        modelID: resolved.modelID,
        agent: resolved.agent,
        variant: resolved.variant,
        text,
        additionalParts,
        messageId: messageID,
      }).then(() => undefined));
    },
  });
  if (!sentMessageID) throw new Error('Failed to prepare review flow message');
  return sentMessageID;
};

const requestChatForceScrollBottom = (sessionId: string): void => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('openchamber:chat-force-scroll-bottom', {
    detail: { sessionId },
  }));
};

const openReviewSessionPanel = (directory: string, session: Session): void => {
  useUIStore.getState().openContextPanelTab(directory, {
    mode: 'chat',
    dedupeKey: `session:${session.id}`,
    label: session.title ?? null,
    sessionTitleFallback: session.title ?? null,
  });
};

type ReviewSessionClient = {
  operation: BoundSessionOperation;
  getSession: (sessionID: string, directory: string) => Promise<Session>;
  createSession: (params: {
    title?: string;
    metadata?: SessionMetadataRecord;
    providerID?: string;
  }, directory: string) => Promise<Session>;
  deleteSession: (sessionID: string, directory: string) => Promise<void>;
};

class ReviewSessionRequestError extends Error {
  readonly status: number | undefined;

  constructor(operation: string, status?: number) {
    super(`${operation} failed`);
    this.name = 'ReviewSessionRequestError';
    this.status = status;
  }
}
const reviewErrorSchema = z.instanceof(Error);
const reviewLinkResponseSchema = z.object({
  replaced: z.boolean(),
  session: z.object({
    id: z.string().min(1),
    directory: z.string().optional(),
  }).passthrough(),
});

export type RetainedReviewSession = RetainedSessionRecovery;

export class ReviewSessionRetainedError extends RetainedSessionError {
  declare readonly recovery: RetainedReviewSession;

  constructor(
    sessionID: string,
    directory: string | null,
    runtimeKey: string,
    cause: Error,
    compensationError: Error,
  ) {
    super(`Review session ${sessionID} was retained: ${compensationError.message}`, {
      sessionID,
      directory,
      runtimeKey,
      cause,
      compensationError,
    });
    this.name = 'ReviewSessionRetainedError';
  }
}


const captureReviewSessionClient = (): ReviewSessionClient => {
  const operation = bindSessionOperation();
  return {
    operation,
    getSession: (sessionID, directory) => operation.get(sessionID, directory),
    createSession: (params, directory) => operation.create(params, directory),
    deleteSession: async (sessionID, directory) => {
      if (await operation.delete(sessionID, directory)) return;
      throw new BoundSessionOperationError('session.delete');
    },
  };
};

const assertReviewSessionCurrent = (
  runtimeKey: string,
  transportEpoch: number,
  client: ReviewSessionClient,
): void => {
  assertAutoReviewRuntimeStillCurrent(runtimeKey);
  if (getRuntimeTransportEpoch() !== transportEpoch) {
    throw new Error('runtime changed');
  }
  client.operation.assertCurrent();
};

const getSessionOrNull = async (
  client: ReviewSessionClient,
  sessionID: string,
  directory: string,
  assertCurrent: () => void,
): Promise<Session | null> => {
  try {
    const session = await client.getSession(sessionID, directory);
    assertCurrent();
    return session;
  } catch (error) {
    assertCurrent();
    if (error instanceof BoundSessionOperationError && error.status === 404) return null;
    throw error;
  }
};

const canReuseReviewSession = (review: Session | null, providerID: string): boolean => {
  if (!review || !isReviewSession(review)) return false;
  return classifyPersistedAgentBackend(review) === classifyRequestedAgentBackend(providerID);
};

const replaceReviewSessionLinkIfCurrent = async (
  client: ReviewSessionClient,
  originalSessionID: string,
  directory: string,
  expectedReviewID: string | null,
  replacementReviewID: string | null,
  assertCurrent: () => void,
): Promise<boolean> => {
  assertCurrent();
  const response = await client.operation.request(
    `/api/openchamber/sessions/${encodeURIComponent(originalSessionID)}/review-link`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        directory,
        expectedReviewSessionId: expectedReviewID,
        replacementReviewSessionId: replacementReviewID,
      }),
    },
  );
  assertCurrent();
  if (!response.ok) throw new ReviewSessionRequestError('session.review-link', response.status);
  const parsedPayload = reviewLinkResponseSchema.safeParse(await response.json().catch(() => null));
  assertCurrent();
  if (!parsedPayload.success) throw new ReviewSessionRequestError('session.review-link', response.status);
  // SAFETY: The review-link gateway returned a validated session identity; remaining SDK session fields pass through unchanged.
  const session = parsedPayload.data.session as Session;
  assertCurrent();
  const returnedDirectory = session.directory?.trim() || directory;
  registerSessionDirectory(session.id, returnedDirectory);
  assertCurrent();
  useGlobalSessionsStore.getState().upsertSession(session);
  return parsedPayload.data.replaced;
};

const resolveSessionDirectory = (session: Session, fallback?: string): string | null => {
  const returnedDirectory = session.directory?.trim();
  return returnedDirectory || fallback?.trim() || null;
};

const activeReviewSessionDirectories = new Map<string, string>();

const resolveLinkedSessionDirectory = (sessionID: string, runtimeKey: string): string | null => {
  const activeDirectory = activeReviewSessionDirectories.get(`${runtimeKey}\u0000${sessionID}`);
  if (activeDirectory) return activeDirectory;
  const session = useGlobalSessionsStore.getState().entityById.get(sessionID)
    ?? getAllSyncSessionMap().get(sessionID);
  return session ? resolveGlobalSessionDirectory(session) : null;
};

const requireLinkedSessionDirectory = (
  sessionID: string,
  runtimeKey: string,
  label: string,
): string => {
  const directory = resolveLinkedSessionDirectory(sessionID, runtimeKey);
  if (!directory) throw new Error(`${label} directory is unavailable`);
  return directory;
};

const removeUnlinkedReviewSession = async (
  client: ReviewSessionClient,
  originalSessionID: string,
  reviewSessionID: string,
  originalDirectory: string,
  reviewDirectory: string,
  runtimeKey: string,
  assertCurrent: () => void,
): Promise<boolean> => {
  const beforeDelete = await client.getSession(originalSessionID, originalDirectory);
  assertCurrent();
  if (getReviewSessionID(beforeDelete) === reviewSessionID) return false;

  let deleteError: Error | null = null;
  try {
    await client.deleteSession(reviewSessionID, reviewDirectory);
  } catch (error) {
    const parsedError = reviewErrorSchema.safeParse(error);
    deleteError = parsedError.success ? parsedError.data : new Error('Failed to remove the replaced review session');
  }
  assertCurrent();

  const afterDelete = await client.getSession(originalSessionID, originalDirectory);
  assertCurrent();
  if (getReviewSessionID(afterDelete) === reviewSessionID) return false;

  const remainingReview = await getSessionOrNull(client, reviewSessionID, reviewDirectory, assertCurrent);
  if (remainingReview) {
    if (deleteError) throw deleteError;
    throw new Error('Failed to remove the replaced review session');
  }
  finalizeConfirmedSessionDeletion(reviewSessionID, reviewDirectory, runtimeKey);
  return true;
};

const removeCreatedUnlinkedReviewSession = async (
  client: ReviewSessionClient,
  originalSessionID: string,
  reviewSessionID: string,
  originalDirectory: string,
  reviewDirectory: string,
): Promise<boolean> => {
  const original = await client.getSession(originalSessionID, originalDirectory);
  if (getReviewSessionID(original) === reviewSessionID) return false;
  await client.deleteSession(reviewSessionID, reviewDirectory);
  return true;
};

const getCurrentReusableReviewSession = async (
  client: ReviewSessionClient,
  originalSessionID: string,
  directory: string,
  providerID: string,
  runtimeKey: string,
  assertCurrent: () => void,
): Promise<Session | null> => {
  const original = await client.getSession(originalSessionID, directory);
  assertCurrent();
  const reviewSessionID = getReviewSessionID(original);
  if (!reviewSessionID) return null;
  const reviewDirectory = requireLinkedSessionDirectory(reviewSessionID, runtimeKey, 'Review session');
  const review = await getSessionOrNull(client, reviewSessionID, reviewDirectory, assertCurrent);
  if (!review || !canReuseReviewSession(review, providerID)) return null;
  return { ...review, directory: reviewDirectory };
};

const getReviewSessionTitle = (original: Session): string => {
  const implementationTitle = original.title?.trim() || original.id;
  return `Review: ${implementationTitle}`;
};

export const createOrReuseReviewSession = async (
  originalSessionID: string,
  directory: string,
  providerID: string,
  expectedRuntimeKey?: string,
): Promise<Session> => {
  const runtimeKey = expectedRuntimeKey ?? getRuntimeKey();
  const transportEpoch = getRuntimeTransportEpoch();
  const client = captureReviewSessionClient();
  const assertCurrent = () => assertReviewSessionCurrent(runtimeKey, transportEpoch, client);
  let createdDirectoryKey: string | null = null;
  try {
    assertCurrent();
    const original = await client.getSession(originalSessionID, directory);
    assertCurrent();
    const originalDirectory = resolveSessionDirectory(original, directory);
    if (!originalDirectory) throw new Error('Original session directory is required');

    const existingReviewID = getReviewSessionID(original);
    const existingReviewDirectory = existingReviewID
      ? requireLinkedSessionDirectory(existingReviewID, runtimeKey, 'Review session')
      : null;
    const existing = existingReviewID && existingReviewDirectory
      ? await getSessionOrNull(client, existingReviewID, existingReviewDirectory, assertCurrent)
      : null;
    assertCurrent();
    if (existing && existingReviewDirectory && canReuseReviewSession(existing, providerID)) {
      return { ...existing, directory: existingReviewDirectory };
    }

    const review = await client.createSession({
      title: getReviewSessionTitle(original),
      metadata: withReviewSessionMarker({}, originalSessionID),
      providerID,
    }, originalDirectory);
    const reviewDirectory = resolveSessionDirectory(review);
    if (!reviewDirectory) {
      const cause = new Error('Review session creation could not continue without its authoritative directory');
      throw new ReviewSessionRetainedError(
        review.id,
        null,
        runtimeKey,
        cause,
        new Error('Exact cleanup target is unknown because the created review directory was not returned'),
      );
    }
    createdDirectoryKey = `${runtimeKey}\u0000${review.id}`;
    activeReviewSessionDirectories.set(createdDirectoryKey, reviewDirectory);

    const assertCurrentOrCompensate = async (): Promise<void> => {
      try {
        assertCurrent();
      } catch (error) {
        const parsedError = reviewErrorSchema.safeParse(error);
        const cause = parsedError.success
          ? parsedError.data
          : new Error('Review session creation stopped because the runtime changed');
        try {
          await removeCreatedUnlinkedReviewSession(
            client,
            originalSessionID,
            review.id,
            originalDirectory,
            reviewDirectory,
          );
        } catch (compensationError) {
          const parsedCompensationError = reviewErrorSchema.safeParse(compensationError);
          throw new ReviewSessionRetainedError(
            review.id,
            reviewDirectory,
            runtimeKey,
            cause,
            parsedCompensationError.success
              ? parsedCompensationError.data
              : new Error('Failed to remove the created review session'),
          );
        }
        throw cause;
      }
    };
    await assertCurrentOrCompensate();

    const cleanReplacement = async (): Promise<Error | null> => {
      try {
        await removeUnlinkedReviewSession(
          client,
          originalSessionID,
          review.id,
          originalDirectory,
          reviewDirectory,
          runtimeKey,
          assertCurrent,
        );
        return null;
      } catch (error) {
        await assertCurrentOrCompensate();
        const parsedError = reviewErrorSchema.safeParse(error);
        return parsedError.success ? parsedError.data : new Error('Failed to remove the replacement review session');
      }
    };

    let linkCommitted = false;
    let linkError: Error | null = null;
    try {
      linkCommitted = await replaceReviewSessionLinkIfCurrent(
        client,
        originalSessionID,
        originalDirectory,
        existingReviewID,
        review.id,
        assertCurrent,
      );
    } catch (error) {
      await assertCurrentOrCompensate();
      const parsedError = reviewErrorSchema.safeParse(error);
      linkError = parsedError.success ? parsedError.data : new Error('Failed to link the replacement review session');
    }
    await assertCurrentOrCompensate();
    if (!linkCommitted) {
      const cleanupError = await cleanReplacement();
      if (cleanupError) {
        throw new ReviewSessionRetainedError(
          review.id,
          reviewDirectory,
          runtimeKey,
          linkError ?? new Error('Review session link changed while creating a replacement'),
          cleanupError,
        );
      }
      const winner = await getCurrentReusableReviewSession(
        client,
        originalSessionID,
        originalDirectory,
        providerID,
        runtimeKey,
        assertCurrent,
      );
      if (winner) return winner;
      if (linkError) throw linkError;
      throw new Error('Review session link changed while creating a replacement');
    }

    let oldCleanupError: Error | null = null;
    const existingDirectory = existing
      ? resolveSessionDirectory(existing, existingReviewDirectory ?? undefined)
      : null;
    if (existing && existingDirectory && isReviewSession(existing)) {
      try {
        await removeUnlinkedReviewSession(
          client,
          originalSessionID,
          existing.id,
          originalDirectory,
          existingDirectory,
          runtimeKey,
          assertCurrent,
        );
      } catch (error) {
        const parsedError = reviewErrorSchema.safeParse(error);
        oldCleanupError = parsedError.success ? parsedError.data : new Error('Failed to remove the replaced review session');
        try {
          await assertCurrentOrCompensate();
        } catch (currentError) {
          if (currentError instanceof RetainedSessionError) throw currentError;
          const parsedCurrentError = reviewErrorSchema.safeParse(currentError);
          throw new ReviewSessionRetainedError(
            existing.id,
            existingDirectory,
            runtimeKey,
            parsedCurrentError.success
              ? parsedCurrentError.data
              : new Error('Review session creation stopped before cleanup was reconciled'),
            oldCleanupError,
          );
        }
      }
    }

    let authority: Session;
    try {
      authority = await client.getSession(originalSessionID, originalDirectory);
      await assertCurrentOrCompensate();
    } catch (error) {
      if (!oldCleanupError || !existing || !existingDirectory || error instanceof RetainedSessionError) throw error;
      const parsedError = reviewErrorSchema.safeParse(error);
      throw new ReviewSessionRetainedError(
        existing.id,
        existingDirectory,
        runtimeKey,
        parsedError.success ? parsedError.data : new Error('Failed to reconcile the linked review session'),
        oldCleanupError,
      );
    }

    if (getReviewSessionID(authority) !== review.id) {
      const cleanupError = await cleanReplacement();
      if (cleanupError) {
        throw new ReviewSessionRetainedError(
          review.id,
          reviewDirectory,
          runtimeKey,
          new Error('Review session link changed while creating a replacement'),
          cleanupError,
        );
      }
      if (oldCleanupError && existing && existingDirectory) {
        throw new ReviewSessionRetainedError(
          existing.id,
          existingDirectory,
          runtimeKey,
          new Error('Review session link changed before previous review cleanup was reconciled'),
          oldCleanupError,
        );
      }
      const winner = await getCurrentReusableReviewSession(
        client,
        originalSessionID,
        originalDirectory,
        providerID,
        runtimeKey,
        assertCurrent,
      );
      if (winner) return winner;
      throw new Error('Review session link changed while creating a replacement');
    }

    if (oldCleanupError && existing && existingDirectory) {
      throw new ReviewSessionRetainedError(
        existing.id,
        existingDirectory,
        runtimeKey,
        new Error('Replacement review was linked but previous review cleanup was not confirmed'),
        oldCleanupError,
      );
    }

    await assertCurrentOrCompensate();
    registerSessionDirectory(review.id, reviewDirectory);
    await assertCurrentOrCompensate();
    useGlobalSessionsStore.getState().upsertSession(review);
    return review;
  } finally {
    if (createdDirectoryKey) activeReviewSessionDirectories.delete(createdDirectoryKey);
    client.operation.release();
  }
};

export const startReviewFlow = async (input: StartReviewFlowInput): Promise<void> => {
  await waitForConnectionOrThrow();
  const expectedAutoReviewRuntimeKey = input.autoReview ? getRuntimeKey() : undefined;
  let reviewPrompt: string;

  if (input.generateHandoff ?? true) {
    const visibleText = await renderMagicPrompt('session.reviewHandoff.visible');
    const instructionsText = await renderMagicPrompt('session.reviewHandoff.instructions');
    const startedAt = Date.now();
    await sendPlainMessage(input.originalSessionID, input.directory, visibleText, null, [
      { text: instructionsText, synthetic: true },
    ], expectedAutoReviewRuntimeKey);

    const continueFromHandoff = async (): Promise<void> => {
      const handoff = await waitForAssistantText(input.originalSessionID, input.directory, startedAt);
      assertAutoReviewRuntimeStillCurrent(expectedAutoReviewRuntimeKey);
      const handoffReviewPrompt = await renderMagicPrompt('session.reviewSession.visible', { handoff });
      const reviewSession = await createOrReuseReviewSession(
        input.originalSessionID,
        input.directory,
        input.providerID,
        expectedAutoReviewRuntimeKey,
      );
      const reviewDirectory = resolveSessionDirectory(reviewSession);
      if (!reviewDirectory) throw new Error('Review session directory is missing');
      const runtimeKey = expectedAutoReviewRuntimeKey ?? getRuntimeKey();
      const waitAfterCreatedAt = Date.now();
      const sentMessageID = await sendPlainMessage(reviewSession.id, reviewDirectory, handoffReviewPrompt, {
        providerID: input.providerID,
        modelID: input.modelID,
        agent: input.agent,
        variant: input.variant,
      }, input.autoReview ? autoReviewReviewerInstructions() : undefined, input.autoReview ? runtimeKey : undefined);
      if (input.autoReview) {
        startAutoReviewRun({
          originalSessionID: input.originalSessionID,
          reviewSessionID: reviewSession.id,
          directory: reviewDirectory,
          runtimeKey,
          status: 'running',
          phase: 'waiting_for_reviewer',
          iteration: 0,
          maxIterations: AUTO_REVIEW_MAX_ITERATIONS,
          expectedAssistantParentID: sentMessageID,
          waitAfterCreatedAt,
        });
      }
      if (!input.autoReview) {
        openReviewSessionPanel(reviewDirectory, reviewSession);
      }
    };

    if (input.returnAfterHandoffRequest) {
      void continueFromHandoff().catch((error) => {
        console.error('[review-flow] failed to finish background review flow', error);
      });
      return;
    }

    await continueFromHandoff();
    return;
  } else {
    reviewPrompt = await renderMagicPrompt('session.reviewSessionWithoutHandoff.visible');
  }

  const reviewSession = await createOrReuseReviewSession(
    input.originalSessionID,
    input.directory,
    input.providerID,
    expectedAutoReviewRuntimeKey,
  );
  const reviewDirectory = resolveSessionDirectory(reviewSession);
  if (!reviewDirectory) throw new Error('Review session directory is missing');
  const runtimeKey = expectedAutoReviewRuntimeKey ?? getRuntimeKey();
  const waitAfterCreatedAt = Date.now();
  const sentMessageID = await sendPlainMessage(reviewSession.id, reviewDirectory, reviewPrompt, {
    providerID: input.providerID,
    modelID: input.modelID,
    agent: input.agent,
    variant: input.variant,
  }, input.autoReview ? autoReviewReviewerInstructions() : undefined, input.autoReview ? runtimeKey : undefined);
  if (input.autoReview) {
    startAutoReviewRun({
      originalSessionID: input.originalSessionID,
      reviewSessionID: reviewSession.id,
      directory: reviewDirectory,
      runtimeKey,
      status: 'running',
      phase: 'waiting_for_reviewer',
      iteration: 0,
      maxIterations: AUTO_REVIEW_MAX_ITERATIONS,
      expectedAssistantParentID: sentMessageID,
      waitAfterCreatedAt,
    });
  }
  if (!input.autoReview) {
    openReviewSessionPanel(reviewDirectory, reviewSession);
  }
};

export const sendReviewFeedbackToOriginal = async (reviewSessionID: string, directory: string, reviewFeedback: string, expectedRuntimeKey?: string): Promise<string> => {
  const runtimeKey = expectedRuntimeKey ?? getRuntimeKey();
  assertAutoReviewRuntimeStillCurrent(expectedRuntimeKey);
  const reviewSession = await opencodeClient.getSession(reviewSessionID, directory);
  assertAutoReviewRuntimeStillCurrent(expectedRuntimeKey);
  const originalSessionID = getOriginalSessionID(reviewSession);
  if (!originalSessionID) throw new Error('Original session is missing');
  const indexedOriginalDirectory = requireLinkedSessionDirectory(originalSessionID, runtimeKey, 'Original session');
  const originalSession = await opencodeClient.getSession(originalSessionID, indexedOriginalDirectory);
  assertAutoReviewRuntimeStillCurrent(expectedRuntimeKey);
  const originalDirectory = resolveSessionDirectory(originalSession, indexedOriginalDirectory);
  if (!originalDirectory) throw new Error('Original session directory is missing');
  const prompt = await renderMagicPrompt('session.reviewFeedbackToImplementer.visible', { review_feedback: reviewFeedback });
  assertAutoReviewRuntimeStillCurrent(expectedRuntimeKey);
  return sendPlainMessage(originalSessionID, originalDirectory, prompt, undefined, undefined, expectedRuntimeKey);
};

export const sendImplementationResponseToReviewer = async (originalSessionID: string, directory: string, implementationResponse: string, autoReview = false, expectedRuntimeKey?: string): Promise<string> => {
  const runtimeKey = expectedRuntimeKey ?? getRuntimeKey();
  const transportEpoch = getRuntimeTransportEpoch();
  const client = captureReviewSessionClient();
  const assertCurrent = () => assertReviewSessionCurrent(runtimeKey, transportEpoch, client);
  try {
    assertCurrent();
    const originalSession = await client.getSession(originalSessionID, directory);
    assertCurrent();
    const originalDirectory = resolveSessionDirectory(originalSession, directory);
    if (!originalDirectory) throw new Error('Original session directory is missing');
    const reviewSessionID = getReviewSessionID(originalSession);
    if (!reviewSessionID) throw new Error('Review session is missing');
    const indexedReviewDirectory = requireLinkedSessionDirectory(reviewSessionID, runtimeKey, 'Review session');
    let reviewSession: Session;
    try {
      reviewSession = await client.getSession(reviewSessionID, indexedReviewDirectory);
      assertCurrent();
    } catch (error) {
      assertCurrent();
      if (!(error instanceof BoundSessionOperationError) || error.status !== 404) throw error;
      await replaceReviewSessionLinkIfCurrent(
        client,
        originalSessionID,
        originalDirectory,
        reviewSessionID,
        null,
        assertCurrent,
      );
      throw error;
    }
    const reviewDirectory = resolveSessionDirectory(reviewSession, indexedReviewDirectory);
    if (!reviewDirectory) throw new Error('Review session directory is missing');
    const prompt = await renderMagicPrompt('session.implementationResponseToReviewer.visible', { implementation_response: implementationResponse });
    assertCurrent();
    const sentMessageID = await sendPlainMessage(reviewSessionID, reviewDirectory, prompt, undefined, autoReview ? autoReviewReviewerInstructions() : undefined, expectedRuntimeKey);
    if (!autoReview) openReviewSessionPanel(reviewDirectory, reviewSession);
    return sentMessageID;
  } finally {
    client.operation.release();
  }
};

export type ReviewTransferDirection = 'review-to-original' | 'original-to-review';

export const getReviewTransferDirection = (session: Session | null | undefined): ReviewTransferDirection | null => {
  if (isReviewSession(session)) return 'review-to-original';
  if (getReviewSessionID(session)) return 'original-to-review';
  return null;
};
