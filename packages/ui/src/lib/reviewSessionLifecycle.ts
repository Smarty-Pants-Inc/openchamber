import type { Session } from '@opencode-ai/sdk/v2/client';
import { z } from 'zod';
import {
  classifyPersistedAgentBackend,
  classifyRequestedAgentBackend,
  getReviewSessionID,
  isReviewSession,
  withReviewSessionMarker,
} from '@/lib/sessionReviewMetadata';
import type { SessionMetadataRecord } from '@/lib/sessionReviewMetadata';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import {
  BoundSessionOperationError,
  bindSessionOperation,
  finalizeConfirmedSessionDeletion,
} from '@/sync/session-actions';
import type { BoundSessionOperation } from '@/sync/session-actions';
import { getAllSyncSessionMap, registerSessionDirectory } from '@/sync/sync-refs';
import { getRuntimeKey, getRuntimeTransportEpoch } from '@/lib/runtime-switch';
import { RetainedSessionError } from '@/lib/retainedSessionError';
import type { RetainedSessionRecovery } from '@/lib/retainedSessionError';

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
  if (runtimeKey !== getRuntimeKey()) {
    throw new Error('Auto-review stopped because the runtime changed.');
  }
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

export const resolveSessionDirectory = (session: Session, fallback?: string): string | null => {
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

export const requireLinkedSessionDirectory = (
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
      title: `Review: ${original.title?.trim() || original.id}`,
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

export const withLinkedReviewSession = async (
  originalSessionID: string,
  directory: string,
  action: (
    reviewSession: Session,
    reviewSessionID: string,
    reviewDirectory: string,
    assertCurrent: () => void,
  ) => Promise<string>,
  expectedRuntimeKey?: string,
): Promise<string> => {
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
    const result = await action(reviewSession, reviewSessionID, reviewDirectory, assertCurrent);
    return result;
  } finally {
    client.operation.release();
  }
};
