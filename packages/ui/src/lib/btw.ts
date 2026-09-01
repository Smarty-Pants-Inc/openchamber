import type { Message, Part, Session } from '@opencode-ai/sdk/v2/client';
import * as sessionActions from '@/sync/session-actions';
import {
  getBtwOriginalSessionID,
  getBtwSessionID,
  getBtwSessionIDFromMetadata,
  isBtwSession,
  withBtwSessionLink,
  withBtwSessionMarker,
  withoutBtwSessionLink,
  withoutBtwSessionMarker,
} from '@/lib/sessionBtwMetadata';
import { withAgentBackendMetadata } from '@/lib/sessionReviewMetadata';
import { useBtwStore } from '@/stores/useBtwStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { confirmRetainedSessionDeletion, RetainedSessionError } from '@/lib/retainedSessionError';

/**
 * `/btw <question>`: fork the main session into a temporary session and send
 * the question there.
 *
 * The fork is created through the server-authorized route so a managed Pi/OMP
 * source cannot race an unmarked history scan. The main chat's current session
 * is never switched; the prompt is routed to the fork with SendMessageOptions.sessionId.
 *
 * The parent session's metadata carries `openchamber.btwSessionID` (see
 * `sessionBtwMetadata`), so the panel belongs to the parent session alone,
 * follows the user as they navigate between sessions, and survives reloads.
 */
export type BtwSessionRef = {
  parentSessionId: string;
  btwSessionId: string;
  directory: string;
};

export type StartBtwInput = {
  parentSessionId: string;
  question: string;
  directory: string;
  providerID: string;
  modelID: string;
  agent?: string;
  variant?: string;
  previousBtwSession?: BtwSessionRef;
};

export const btwSessionTitle = (question: string): string => `btw: ${question}`;


export async function startBtwSession(input: StartBtwInput): Promise<Session> {
  const { setPanelState, clearPanelState } = useBtwStore.getState();
  setPanelState(input.parentSessionId, { creating: true });
  try {
    await sessionActions.waitForConnectionOrThrow();
    const operation = sessionActions.bindSessionOperation();
    try {
      const runtimeKey = operation.runtimeKey;
      const forked = await operation.fork(
        input.parentSessionId,
        undefined,
        input.providerID,
        input.directory,
      );
      // Once the authorized endpoint returns an ID, this flow owns remote
      // compensation on its bound transport. Begin that scope before reading
      // any response fields; only local-state publication is current-guarded.
      let sessionDirectory = input.directory;
      let parentLinkedToFork = false;
      let restorePreviousBtwLink = async (): Promise<boolean> => true;
      try {
        // The server may canonicalize the worktree path; the prompt must use
        // the same directory identity as the forked session.
        // SAFETY: the SDK Session type omits the server's `directory` field;
        // this widening only reads it, with the requested directory fallback.
        sessionDirectory = (forked as Session & { directory?: string | null }).directory ?? input.directory;
        const previousBtwSession = input.previousBtwSession;
        const expectedPreviousBtwID = previousBtwSession?.btwSessionId ?? null;

        restorePreviousBtwLink = async (): Promise<boolean> => {
          let restoreBtwID: string | null = null;
          if (previousBtwSession) {
            const previous = await operation.get(previousBtwSession.btwSessionId, previousBtwSession.directory);
            if (
              isBtwSession(previous)
              && getBtwOriginalSessionID(previous) === input.parentSessionId
            ) {
              restoreBtwID = previousBtwSession.btwSessionId;
            }
          }

          const restoredParent = await operation.patchMetadata(
            input.parentSessionId,
            input.directory,
            (metadata) => {
              if (getBtwSessionIDFromMetadata(metadata) !== forked.id) return metadata;
              return restoreBtwID
                ? withBtwSessionLink(metadata, restoreBtwID)
                : withoutBtwSessionLink(metadata, forked.id);
            },
          );
          return getBtwSessionID(restoredParent) !== forked.id;
        };

        operation.assertCurrent();
        // The fork API cannot accept metadata. Make the inherited fork a hidden
        // backend-owned btw session before reading history or publishing it.
        await operation.patchMetadata(
          forked.id,
          sessionDirectory,
          (metadata) => withAgentBackendMetadata(
            withBtwSessionMarker(metadata, input.parentSessionId, null),
            input.providerID,
          ) ?? metadata,
        );
        operation.assertCurrent();

        // The boundary between inherited history and the fork's own tail is the
        // id of the newest cloned message. Transcript records are chronological,
        // so tail rendering finds this exact record instead of comparing IDs.
        const newestCloned = await operation.getMessages(forked.id, 1, sessionDirectory);
        operation.assertCurrent();
        const boundaryMessageID = newestCloned[newestCloned.length - 1]?.info.id ?? null;

        // The marker lands before local publication: btw forks are hidden from
        // session lists by this marker, so an unmarked fork never flashes there.
        const marked = await operation.patchMetadata(
          forked.id,
          sessionDirectory,
          (metadata) => withAgentBackendMetadata(
            withBtwSessionMarker(metadata, input.parentSessionId, boundaryMessageID),
            input.providerID,
          ) ?? metadata,
        );
        operation.assertCurrent();

        let forkForPublication = marked;
        try {
          forkForPublication = await operation.updateTitle(
            forked.id,
            btwSessionTitle(input.question),
            sessionDirectory,
          );
          operation.assertCurrent();
        } catch {
          // A title is cosmetic, but a stale title response still aborts and
          // compensates the owned fork below.
          operation.assertCurrent();
        }

        const parentBeforeLink = await operation.get(input.parentSessionId, input.directory);
        operation.assertCurrent();
        if (getBtwSessionID(parentBeforeLink) !== expectedPreviousBtwID) {
          throw new Error('BTW session changed before replacement');
        }
        if (previousBtwSession) {
          if (previousBtwSession.parentSessionId !== input.parentSessionId) {
            throw new Error('BTW session changed before replacement');
          }
          const previous = await operation.get(previousBtwSession.btwSessionId, previousBtwSession.directory);
          operation.assertCurrent();
          if (!isBtwSession(previous) || getBtwOriginalSessionID(previous) !== input.parentSessionId) {
            throw new Error('BTW session changed before replacement');
          }
        }

        // Link the parent only if it is still in the state that the submit
        // observed. The conditional updater avoids overwriting a concurrent
        // promote/destroy/replacement operation.
        const linkedParent = await operation.patchMetadata(
          input.parentSessionId,
          input.directory,
          (metadata) => (
            getBtwSessionIDFromMetadata(metadata) === expectedPreviousBtwID
              ? withBtwSessionLink(metadata, forked.id)
              : metadata
          ),
        );
        parentLinkedToFork = getBtwSessionID(linkedParent) === forked.id;
        operation.assertCurrent();
        if (!parentLinkedToFork) {
          throw new Error('BTW session changed before replacement');
        }

        await useSessionUIStore.getState().sendMessage(
          input.question,
          input.providerID,
          input.modelID,
          input.agent,
          [],
          undefined,
          undefined,
          input.variant,
          'normal',
          { target: { runtimeKey, sessionId: forked.id, directory: sessionDirectory } },
        );
        operation.assertCurrent();

        // These synchronous publications are the only local mutations in the
        // flow. The bound operation rejects stale authority immediately before
        // each one; compensation below never uses that guard.
        operation.publish(forkForPublication, sessionDirectory);
        operation.publish(linkedParent, input.directory);

        if (previousBtwSession) {
          try {
            const currentParent = await operation.get(input.parentSessionId, input.directory);
            operation.assertCurrent();
            const previous = await operation.get(previousBtwSession.btwSessionId, previousBtwSession.directory);
            operation.assertCurrent();
            if (
              getBtwSessionID(currentParent) === forked.id
              && isBtwSession(previous)
              && getBtwOriginalSessionID(previous) === input.parentSessionId
            ) {
              const deleted = await operation.delete(previousBtwSession.btwSessionId, previousBtwSession.directory);
              if (deleted) {
                operation.finalizeDeletion(previousBtwSession.btwSessionId, previousBtwSession.directory);
              }
            }
          } catch {
            // The new linked fork is already usable; a concurrent management
            // action or cleanup transport failure must not roll it back.
          }
        }
      } catch (error) {
        const cause = error instanceof Error ? error : new Error('BTW session creation failed');
        let rollbackError: Error | null = null;
        if (parentLinkedToFork) {
          try {
            if (!await restorePreviousBtwLink()) {
              rollbackError = new Error('Failed to confirm restoration of the previous BTW link');
            }
          } catch (restoreError) {
            rollbackError = restoreError instanceof Error
              ? restoreError
              : new Error('Failed to restore the previous BTW link');
          }
        }
        if (rollbackError) {
          throw new RetainedSessionError(`BTW session ${forked.id} was retained: ${rollbackError.message}`, {
            sessionID: forked.id,
            directory: sessionDirectory,
            runtimeKey,
            cause,
            compensationError: rollbackError,
          });
        }
        await confirmRetainedSessionDeletion({
          sessionID: forked.id,
          directory: sessionDirectory,
          runtimeKey,
          cause,
          failureMessage: 'Failed to confirm removal of the BTW session',
          deleteSession: () => operation.delete(forked.id, sessionDirectory),
        });
        throw cause;
      }
      return forked;
    } finally {
      operation.release();
    }
  } finally {
    clearPanelState(input.parentSessionId);
  }
}

/**
 * Keep only the fork's own tail: messages after the last message cloned from
 * the parent. A `null` boundary means the fork inherited nothing. A missing
 * non-null boundary is tail only after the newest page resolves.
 */
export function filterBtwTailMessages(
  records: Array<{ info: Message; parts: Part[] }>,
  boundaryMessageID: string | null,
  newestPageResolved = false,
): Array<{ info: Message; parts: Part[] }> {
  if (!boundaryMessageID) return records;
  const boundaryIndex = records.findIndex((record) => record.info.id === boundaryMessageID);
  return boundaryIndex < 0 ? (newestPageResolved ? records : []) : records.slice(boundaryIndex + 1);
}

/** Newest-page authority stays valid until its target changes. */
export const isBtwNewestPageResolved = (
  requestedGeneration: number | null,
  currentGeneration: number,
): boolean => requestedGeneration !== null
  && currentGeneration >= requestedGeneration;

export type BtwNewestPageAuthority = { target: string; generation: number };

/** A successful later generation for the same target supersedes an older refresh. */
export const adoptBtwNewestPageAuthority = (
  current: BtwNewestPageAuthority | null,
  target: string,
  generation: number,
  loadStatus: string,
): BtwNewestPageAuthority | null => {
  if (loadStatus !== 'ready') return current;
  if (!current || current.target !== target || generation > current.generation) {
    return { target, generation };
  }
  return current;
};


/**
 * Destroy the temporary fork only after the bound runtime confirms deletion.
 * An unconfirmed delete leaves the server-backed parent link intact so the
 * surviving fork remains available to the user.
 */
export async function destroyBtwSession(ref: BtwSessionRef): Promise<boolean> {
  const { setPanelState, clearPanelState } = useBtwStore.getState();
  setPanelState(ref.parentSessionId, { destroying: true });
  const operation = sessionActions.bindSessionOperation();
  let confirmed = false;
  try {
    operation.assertCurrent();
    const deleted = await operation.delete(ref.btwSessionId, ref.directory);
    operation.assertCurrent();
    if (!deleted) return false;

    const parent = await operation.patchMetadata(ref.parentSessionId, ref.directory, (metadata) => (
      withoutBtwSessionLink(metadata, ref.btwSessionId)
    ));
    operation.assertCurrent();
    if (getBtwSessionID(parent) === ref.btwSessionId) {
      throw new Error('Failed to confirm removal of the BTW link');
    }

    operation.publish(parent, ref.directory);
    operation.finalizeDeletion(ref.btwSessionId, ref.directory);
    confirmed = true;
    clearPanelState(ref.parentSessionId);
    return true;
  } catch {
    return false;
  } finally {
    operation.release();
    if (!confirmed) setPanelState(ref.parentSessionId, { destroying: false });
  }
}

/**
 * Keep the fork as a normal session. The marker is removed before the parent
 * link so a failed cleanup leaves the original linked fork usable.
 */
export async function promoteBtwSession(ref: BtwSessionRef): Promise<void> {
  const operation = sessionActions.bindSessionOperation();
  try {
    operation.assertCurrent();
    const promotedFork = await operation.patchMetadata(
      ref.btwSessionId,
      ref.directory,
      withoutBtwSessionMarker,
    );
    operation.assertCurrent();
    if (isBtwSession(promotedFork)) throw new Error('Failed to confirm BTW promotion');

    const parent = await operation.patchMetadata(ref.parentSessionId, ref.directory, (metadata) => (
      withoutBtwSessionLink(metadata, ref.btwSessionId)
    ));
    operation.assertCurrent();
    if (getBtwSessionID(parent) === ref.btwSessionId) {
      throw new Error('Failed to confirm removal of the BTW link');
    }

    operation.publish(promotedFork, ref.directory);
    operation.publish(parent, ref.directory);
    useBtwStore.getState().clearPanelState(ref.parentSessionId);
    useSessionUIStore.getState().setCurrentSession(ref.btwSessionId, ref.directory);
  } finally {
    operation.release();
  }
}
