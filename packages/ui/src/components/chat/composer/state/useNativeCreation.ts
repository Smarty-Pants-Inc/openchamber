import React from 'react';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { NativeCreationError, NATIVE_CREATION_INVALIDATED, type NativeCreationState } from '@/lib/opencode/nativeCreation';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSessionUIStore, type NewSessionDraftState } from '@/sync/session-ui-store';
import { isNativeDraftTarget, nativeCreationForDraft, prepareNativeDraft, preparedNativeDraft, recheckNativeDraft } from '@/sync/native-draft-creation';
import { refreshNativeCreation, replyNativeCreation, resumeNativeCreation } from '@/sync/native-draft-control';
import { prepareNativeDraftSend, resumeAcceptedNativeDraft } from '@/sync/native-draft-send';

type Capability = { runtimeKey: string; directory: string; mode: 'ordinary' | 'legacy' | 'unavailable'; operations: NativeCreationState[] };

export function useNativeCreation(draft: NewSessionDraftState, sessionId: string | null,
  currentDirectory: string | undefined, runtimeKey: string) {
  const { t } = useI18n();
  const scoped = useSessionUIStore(s => nativeCreationForDraft(s.nativeDraftCreations, draft, runtimeKey));
  const selected = useSessionUIStore(s => [...s.nativeDraftCreations.values()].find(entry =>
    entry.status === 'created' && entry.runtimeKey === runtimeKey && entry.session.id === sessionId));
  React.useEffect(() => { resumeAcceptedNativeDraft(); }, [scoped]);
  const [capability, setCapability] = React.useState<Capability | null>(null);
  const [revision, recheck] = React.useReducer(value => value + 1, 0);
  const directory = draft.directoryOverride ?? currentDirectory;
  React.useEffect(() => {
    if (!draft.open || !directory) return;
    let cancelled = false, request = 0;
    const check = async () => {
      const ticket = ++request;
      try {
        const support = await opencodeClient.nativeCreationMode(directory);
        const operations = support === 'interactive' ? await opencodeClient.listNativeCreations(directory) : [];
        if (operations.some(operation => operation.directory !== directory)) throw new NativeCreationError('stale');
        if (cancelled || ticket !== request || getRuntimeKey() !== runtimeKey) return;
        setCapability({ runtimeKey, directory, mode: support === 'legacy' ? 'legacy' : 'ordinary', operations });
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
  }, [directory, draft.open, draft.draftId, runtimeKey, revision]);

  const mode = capability?.runtimeKey === runtimeKey && capability.directory === directory
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
  const canCreate = mode === 'ordinary' && !scoped && isNativeDraftTarget(draft)
    && operations.every(operation => ['denied', 'cancelled', 'expired', 'ready'].includes(operation.phase));
  return {
    mode, session, creation: scoped, operations,
    refresh: () => perform(async () => {
      if (scoped?.status === 'pending') await refreshNativeCreation();
      else if (scoped?.status === 'failed' && !scoped.submitted) await recheckNativeDraft();
      recheck();
    }),
    resume: (operation: NativeCreationState) => perform(() => resumeNativeCreation(operation)),
    reply: (action: Parameters<typeof replyNativeCreation>[0]) => perform(() => replyNativeCreation(action)),
    canCreate, describeError,
    create: () => perform(async () => {
      if (!canCreate) throw new NativeCreationError('required');
      await prepareNativeDraft();
    }),
    beforeSend: async () => {
      guard();
      if (draft.open) {
        const native = await preparedNativeDraft(draft);
        if (native) return prepareNativeDraftSend(draft, native);
      }
    },
  };
}
