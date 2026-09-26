import React from 'react';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { NativeCreationError, NATIVE_CREATION_INVALIDATED, type NativeCreationState } from '@/lib/opencode/nativeCreation';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSessionUIStore, type NewSessionDraftState } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { nativeCreationForDraft, preparedNativeDraft, recheckNativeDraft } from '@/sync/native-draft-creation';
import { refreshNativeCreation, replyNativeCreation } from '@/sync/native-draft-control';
import { startNativeDraft } from '@/sync/native-draft-start';
import { prepareNativeDraftSend, resumeAcceptedNativeDraft } from '@/sync/native-draft-send';
import { isVSCodeRuntime } from '@/stores/utils/vscodeRuntime';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { discoveryAnswered, discoveryPendingFor } from '@/lib/managed-discovery';

export { discoveryPendingFor } from '@/lib/managed-discovery';

type Capability = { runtimeKey: string; directory: string; mode: 'ordinary' | 'legacy' | 'unavailable'; operations: NativeCreationState[];
  /** The server can settle an unreadable start for good, so a new one may begin (smarty-code#340). */
  abandon?: boolean };

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
  const [refusal, setRefusal] = React.useState<{ key: string; error: NativeCreationError } | null>(null);
  const directory = draft.directoryOverride ?? currentDirectory;
  // A check before the managed catalog admits this directory is refused by the gateway; check
  // again when the catalog publishes instead of leaving the draft unavailable (smarty-code#113).
  // Nor check before discovery answers at all: the directory in hand (the home fallback) may not be admitted either.
  const catalogStatus = useProjectsStore(s => s.managedCatalogStatus);
  const answered = useProjectsStore(discoveryAnswered);
  const discoveryPending = discoveryPendingFor(catalogStatus, answered) && !isVSCodeRuntime(getRegisteredRuntimeAPIs());
  React.useEffect(() => {
    if (!draft.open || !directory || discoveryPending) return;
    let cancelled = false, request = 0;
    const check = async () => {
      const ticket = ++request;
      try {
        const { mode: support, abandon } = await opencodeClient.nativeCreationSupport(directory);
        const operations = support === 'interactive' ? await opencodeClient.listNativeCreations(directory) : [];
        if (operations.some(operation => operation.directory !== directory)) throw new NativeCreationError('stale');
        if (cancelled || ticket !== request || getRuntimeKey() !== runtimeKey) return;
        setCapability({ runtimeKey, directory, mode: support === 'legacy' ? 'legacy' : 'ordinary', operations, abandon });
        await refreshNativeCreation();
      } catch {
        if (!cancelled && ticket === request && getRuntimeKey() === runtimeKey) {
          setCapability({ runtimeKey, directory, mode: 'unavailable', operations: [] });
        }
      }
    };
    const invalidated = (event: Event) => {
      // SAFETY: This named app event is advisory; its scope is compared before an authorized refresh.
      const detail = (event as CustomEvent<{ runtimeKey: string; directory?: string }>).detail;
      if (detail?.runtimeKey === runtimeKey && (!detail.directory || detail.directory === directory)) void check();
    };
    window.addEventListener(NATIVE_CREATION_INVALIDATED, invalidated);
    void check();
    return () => { cancelled = true; window.removeEventListener(NATIVE_CREATION_INVALIDATED, invalidated); };
  }, [directory, draft.open, draft.draftId, runtimeKey, revision, catalogStatus, discoveryPending]);

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
    refresh: () => perform(async () => {
      if (scoped?.status === 'pending') await refreshNativeCreation();
      else if (scoped?.status === 'failed' && !scoped.submitted) await recheckNativeDraft();
      recheck();
    }),
    cancel: () => perform(() => replyNativeCreation('cancel')),
    describeError,
    /** Send on a new-session draft starts its session first (native-draft-start), then sends once. */
    beforeSend: async () => {
      setRefusal(null);
      try {
        guard();
        if (draft.open) {
          await startNativeDraft(operations);
          guard();
          const native = await preparedNativeDraft(draft);
          if (native) return prepareNativeDraftSend(draft, native);
        }
      } catch (cause) {
        const error = cause instanceof NativeCreationError ? cause : new NativeCreationError('unavailable', cause);
        // A second press while the first is still starting needs no line: the first one's own line is showing.
        // Only for the draft and target that are still shown (a late refusal of a switched-away target is not shown).
        const now = useSessionUIStore.getState().newSessionDraft;
        const still = `${getRuntimeKey()}\0${now.draftId}\0${now.selectedProjectId ?? ''}\0${now.directoryOverride ?? ''}` === refusalFor;
        if (draft.open && still && error.code !== 'sending') setRefusal({ key: refusalFor, error });
        throw error;
      }
    },
  };
}
