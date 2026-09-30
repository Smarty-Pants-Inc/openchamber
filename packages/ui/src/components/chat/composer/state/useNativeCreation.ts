import React from 'react';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { NativeCreationError, NATIVE_CREATION_INVALIDATED, nativeCreationFailure, type NativeCreationState } from '@/lib/opencode/nativeCreation';
import { newOperationId, reportClientError } from '@/lib/clientErrorReport';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSessionUIStore, type NewSessionDraftState } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { nativeCreationForDraft, preparedNativeDraft, recheckNativeDraft } from '@/sync/native-draft-creation';
import { refreshNativeCreation, replyNativeCreation } from '@/sync/native-draft-control';
import { startNativeDraft } from '@/sync/native-draft-start';
import { prepareNativeDraftSend, resumeAcceptedNativeDraft } from '@/sync/native-draft-send';
import { isVSCodeRuntime } from '@/stores/utils/vscodeRuntime';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { discoveryAnswered, discoveryPendingFor } from '@/lib/managed-discovery';

export { discoveryPendingFor } from '@/lib/managed-discovery';

type Capability = { runtimeKey: string; directory: string; mode: 'ordinary' | 'legacy' | 'unavailable' | 'notAdmitted'; operations: NativeCreationState[];
  /** The server can settle an unreadable start for good, so a new one may begin (smarty-code#340). */
  abandon?: boolean };

/** Waits before checking a just-made worktree again while the gateway admits it (smarty-code#629): about 15 s in all. */
export const NEW_TREE_RETRY_MS = [1_000, 2_000, 4_000, 8_000];

export function useNativeCreation(draft: NewSessionDraftState, sessionId: string | null,
  currentDirectory: string | undefined, runtimeKey: string) {
  const { t } = useI18n();
  const scoped = useSessionUIStore(s => nativeCreationForDraft(s.nativeDraftCreations, draft, runtimeKey));
  const selected = useSessionUIStore(s => [...s.nativeDraftCreations.values()].find(entry =>
    entry.status === 'created' && entry.runtimeKey === runtimeKey && entry.session.id === sessionId));
  React.useEffect(() => { resumeAcceptedNativeDraft(); }, [scoped]);
  const [capability, setCapability] = React.useState<Capability | null>(null);
  const [revision, recheck] = React.useReducer(value => value + 1, 0);
  // Why the last Send on this draft was refused before anything was sent; shown until the next Send or another draft.
  // Bound to the draft, its project and directory, and the server: a switch shows no other target's refusal.
  const refusalFor = `${runtimeKey}\0${draft.draftId}\0${draft.selectedProjectId ?? ''}\0${draft.directoryOverride ?? ''}`;
  // A refusal is said only while its draft and target are still shown: a late refusal of a switched-away target (a
  // press made before the switch) never replaces the shown target's line.
  const stillShown = () => {
    const now = useSessionUIStore.getState().newSessionDraft;
    return now.open && `${getRuntimeKey()}\0${now.draftId}\0${now.selectedProjectId ?? ''}\0${now.directoryOverride ?? ''}` === refusalFor;
  };
  const [refusal, setRefusal] = React.useState<{ key: string; error: NativeCreationError } | null>(null);
  const directory = draft.directoryOverride ?? currentDirectory;
  // A check before the managed catalog admits this directory is refused by the gateway; check
  // again when the catalog publishes instead of leaving the draft unavailable (smarty-code#113).
  // Nor check before discovery answers at all: the directory in hand (the home fallback) may not be admitted either.
  const catalogStatus = useProjectsStore(s => s.managedCatalogStatus);
  const answered = useProjectsStore(discoveryAnswered);
  const discoveryPending = discoveryPendingFor(catalogStatus, answered) && !isVSCodeRuntime(getRegisteredRuntimeAPIs());
  // A new worktree ('+ New') binds the draft before its tree exists: check only once it is made (the check names the tree,
  // which the gateway admits it on), and again once the catalog admits this directory (smarty-code#629).
  const admitted = useDirectoryStore(s => s.managedDirectories?.includes(directory ?? '') ?? false);
  React.useEffect(() => {
    if (!draft.open || !directory || discoveryPending || draft.pendingWorktreeRequestId) return;
    // A finished check is kept unless a newer one was already applied: under steady invalidations (a frozen start's
    // ~12 s reads) dropping every superseded one would leave the stuck start, and its Stop, unshown (smarty-code#523).
    let cancelled = false, request = 0, applied = 0, retries = 0, retry: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      // One pending recheck at most: a new check (an invalidation during the wait) replaces it; nothing after cleanup.
      clearTimeout(retry);
      if (cancelled || getRuntimeKey() !== runtimeKey) return;
      const ticket = ++request;
      try {
        const { mode: support, abandon } = await opencodeClient.nativeCreationSupport(directory);
        const operations = support === 'interactive' ? await opencodeClient.listNativeCreations(directory) : [];
        if (operations.some(operation => operation.directory !== directory)) throw new NativeCreationError('stale');
        if (cancelled || ticket <= applied || getRuntimeKey() !== runtimeKey) return;
        applied = ticket;
        setCapability({ runtimeKey, directory, mode: support === 'legacy' ? 'legacy' : 'ordinary', operations, abandon });
        await refreshNativeCreation();
      } catch (cause) {
        // Never over a newer applied result; the same check failing after its own result (refresh) still says so.
        if (cancelled || ticket < applied || getRuntimeKey() !== runtimeKey) return;
        // The draft's own '+ New' tree: the gateway admits it a moment after it is made and refuses until then
        // (smarty-code#629). Check again shortly instead of saying the server is unreachable; only then say so.
        if (directory === draft.bootstrapPendingDirectory && retries < NEW_TREE_RETRY_MS.length) {
          if (ticket === request) retry = setTimeout(() => void check(), NEW_TREE_RETRY_MS[retries++]);
          return;
        }
        applied = ticket;
        // smarty-code#966: a remembered project the ready catalog no longer admits answers 403 "Project is not
        // configured" (after the new-tree rechecks above, which a just-made tree takes first: openchamber#441 r1). The
        // server is reachable: say the project is gone (choose another), never "Cannot reach the server".
        if ((cause as { status?: number } | undefined)?.status === 403 && catalogStatus === 'ready' && !admitted) {
          setCapability({ runtimeKey, directory, mode: 'notAdmitted', operations: [] }); return;
        }
        setCapability({ runtimeKey, directory, mode: 'unavailable', operations: [] });
      }
    };
    const invalidated = (event: Event) => {
      // SAFETY: This named app event is advisory; its scope is compared before an authorized refresh.
      const detail = (event as CustomEvent<{ runtimeKey: string; directory?: string }>).detail;
      if (detail?.runtimeKey === runtimeKey && (!detail.directory || detail.directory === directory)) void check();
    };
    window.addEventListener(NATIVE_CREATION_INVALIDATED, invalidated);
    void check();
    return () => { cancelled = true; clearTimeout(retry); window.removeEventListener(NATIVE_CREATION_INVALIDATED, invalidated); };
  }, [directory, draft.open, draft.draftId, draft.pendingWorktreeRequestId, draft.bootstrapPendingDirectory, runtimeKey, revision, catalogStatus, discoveryPending, admitted]);

  const mode = discoveryPending ? 'discovering' : capability?.runtimeKey === runtimeKey && capability.directory === directory
    ? capability.mode : 'loading';
  const operations = capability?.runtimeKey === runtimeKey && capability.directory === directory ? capability.operations : [];
  const creation = scoped ?? selected;
  const session = creation?.status === 'created' ? creation.session : null;
  const describeError = (cause: unknown) => {
    const error = cause instanceof NativeCreationError ? cause : new NativeCreationError('unavailable', cause);
    const message = error.detail ?? t(`chat.nativeCreation.${error.code}`);
    return error.reference ? `${message}\n${error.reference.id}\n${error.reference.directory}` : message;
  };
  const guard = () => {
    const now = useSessionUIStore.getState().newSessionDraft;
    if (getRuntimeKey() !== runtimeKey || now.draftId !== draft.draftId || now.directoryOverride !== draft.directoryOverride
      || now.selectedProjectId !== draft.selectedProjectId) throw new NativeCreationError('stale');
  };
  const perform = async (action: () => Promise<void>) => {
    try { guard(); await action(); } catch (error) { toast.error(describeError(error)); }
  };
  return {
    mode, session, creation: scoped, operations,
    canAbandon: capability?.runtimeKey === runtimeKey && capability.directory === directory && capability.abandon === true,
    refusal: refusal?.key === refusalFor ? refusal.error : null,
    /** A native Send that failed after its start (its prompt was never admitted): keep saying why (smarty-dev#856). */
    // Its own words when it has them: the backend's recovery message, or the send's refusal reason (a 409's "finish
    // the original dialogs"), else the plain send failure. Returned, so the toast says the same.
    noteRefusal: (cause: unknown): NativeCreationError => {
      const reason = (cause as { refusalReason?: unknown } | null)?.refusalReason, parsed = nativeCreationFailure(cause);
      const error = cause instanceof NativeCreationError || parsed.detail ? parsed
        : new NativeCreationError('unavailable', cause, typeof reason === 'string' ? reason : t('chat.chatInput.toast.messageSendFailed'));
      // A second press: the first Send is still under way and says its own outcome.
      if (error.code !== 'sending' && stillShown()) { setRefusal({ key: refusalFor, error }); reportClientError({ kind: `send.${error.code}`, status: error.status, runtimeKey, operationId: `${refusalFor}\0${error.code}` }); } // The code, never the server's words.
      return error;
    },
    refresh: () => perform(async () => {
      if (scoped?.status === 'pending') await refreshNativeCreation();
      else if (scoped?.status === 'failed' && !scoped.submitted) await recheckNativeDraft();
      recheck();
    }),
    cancel: () => perform(() => replyNativeCreation('cancel')),
    describeError,
    /** Send on a new-session draft starts its session first (native-draft-start), then sends once. */
    beforeSend: async () => {
      const revealTicket = draft.open ? useSessionUIStore.getState().beginSessionReveal() : undefined;
      const operationId = newOperationId(); // This start, before its first await.
      setRefusal(null);
      try {
        guard();
        if (draft.open) {
          await startNativeDraft(operations);
          guard();
          const native = await preparedNativeDraft(draft);
          // Awaited here, so a refusal while preparing (history, target) is caught below and said, never lost.
          if (native) return await prepareNativeDraftSend(draft, native, revealTicket);
        }
        if (revealTicket) useSessionUIStore.getState().consumeSessionReveal(revealTicket.revision);
        return undefined;
      } catch (cause) {
        if (revealTicket) useSessionUIStore.getState().consumeSessionReveal(revealTicket.revision);
        const error = cause instanceof NativeCreationError ? cause : new NativeCreationError('unavailable', cause);
        // A second press while the first is still starting needs no line: the first one's own line is showing.
        if (stillShown() && error.code !== 'sending') { setRefusal({ key: refusalFor, error }); reportClientError({ kind: `start.${error.code}`, status: error.status, runtimeKey, operationId }); } // The code, never the server's words.
        throw error;
      }
    },
  };
}
