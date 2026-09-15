import React from 'react';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { NativeCreationError } from '@/lib/opencode/nativeCreation';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSessionUIStore, type NewSessionDraftState } from '@/sync/session-ui-store';
import { isNativeDraftTarget, nativeCreationForDraft, prepareNativeDraft, preparedNativeDraft, recheckNativeDraft } from '@/sync/native-draft-creation';
import { prepareNativeDraftSend } from '@/sync/native-draft-send';

type Capability = { runtimeKey: string; directory: string; mode: 'ordinary' | 'legacy' | 'unavailable' };

export function useNativeCreation(draft: NewSessionDraftState, sessionId: string | null,
  currentDirectory: string | undefined, runtimeKey: string) {
  const { t } = useI18n();
  const scoped = useSessionUIStore(s => nativeCreationForDraft(s.nativeDraftCreations, draft, runtimeKey));
  const selected = useSessionUIStore(s => [...s.nativeDraftCreations.values()].find(entry =>
    entry.status === 'created' && entry.runtimeKey === runtimeKey && entry.session.id === sessionId));
  const [capability, setCapability] = React.useState<Capability | null>(null);
  const [revision, recheck] = React.useReducer(value => value + 1, 0);
  const directory = draft.directoryOverride ?? currentDirectory;
  React.useEffect(() => {
    if (!draft.open || !directory) return;
    let cancelled = false;
    const publish = (mode: Capability['mode']) => {
      if (!cancelled && getRuntimeKey() === runtimeKey) setCapability({ runtimeKey, directory, mode });
    };
    void opencodeClient.supportsNativeCreation(directory).then(
      supported => publish(supported ? 'ordinary' : 'legacy'), () => publish('unavailable'),
    );
    return () => { cancelled = true; };
  }, [directory, draft.open, runtimeKey, revision]);

  const mode = capability?.runtimeKey === runtimeKey && capability.directory === directory
    ? capability.mode : 'loading';
  const creation = scoped ?? selected;
  const session = creation?.status === 'created' ? creation.session : null;
  const describeError = (cause: unknown) => {
    const error = cause instanceof NativeCreationError ? cause : new NativeCreationError('unavailable', cause);
    const message = error.detail ?? t(`chat.nativeCreation.${error.code}`);
    return error.reference ? `${message}\n${error.reference.id}\n${error.reference.directory}` : message;
  };
  return {
    mode, session, creation: scoped,
    refresh: async () => {
      if (scoped) {
        try {
          const supported = await recheckNativeDraft();
          if (getRuntimeKey() === runtimeKey && directory) setCapability({ runtimeKey, directory, mode: supported ? 'ordinary' : 'legacy' });
        } catch (error) { toast.error(describeError(error)); }
      } else { setCapability(null); recheck(); }
    },
    canCreate: mode === 'ordinary' && !scoped && isNativeDraftTarget(draft),
    describeError,
    create: async () => {
      try { await prepareNativeDraft(); } catch (error) { toast.error(describeError(error)); }
    },
    beforeSend: async () => {
      if (getRuntimeKey() !== runtimeKey) throw new NativeCreationError('stale');
      if (draft.open) {
        const native = await preparedNativeDraft(draft);
        if (native) await prepareNativeDraftSend(draft, native);
      }
    },
  };
}
