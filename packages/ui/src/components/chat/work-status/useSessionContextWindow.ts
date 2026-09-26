import React from 'react';
import { readOrdinaryModel } from '@/lib/opencode/ordinaryModel';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSession, useSessionMessages } from '@/sync/sync-context';
import { sessionContextWindow } from './contextUsage';

/** The context window of the model this session runs (contextUsage.ts), shared by the work-status panel and header. */
export function useSessionContextWindow(sessionId: string | null | undefined, directory: string | null | undefined) {
  const providers = useConfigStore((state) => state.providers);
  const currentProviderId = useConfigStore((state) => state.currentProviderId);
  const currentModelId = useConfigStore((state) => state.currentModelId);
  const session = useSession(sessionId ?? null, directory ?? undefined);
  const messages = useSessionMessages(sessionId ?? '', directory ?? undefined);
  const ordinaryState = readOrdinaryModel(session ?? undefined);
  // An ordinary session (the state exists) without a model: its window is unknown, not its history's.
  const ordinaryUnavailable = ordinaryState !== undefined && !ordinaryState.model;
  const ordinaryProvider = ordinaryState?.model?.providerID;
  const ordinaryModel = ordinaryState?.model?.modelID;
  return React.useMemo(() => sessionContextWindow(providers,
    ordinaryUnavailable ? 'unavailable'
      : ordinaryProvider && ordinaryModel ? { providerID: ordinaryProvider, modelID: ordinaryModel } : null,
    messages as unknown as Parameters<typeof sessionContextWindow>[2],
    currentProviderId && currentModelId ? { providerID: currentProviderId, modelID: currentModelId } : null),
  [providers, ordinaryUnavailable, ordinaryProvider, ordinaryModel, messages, currentProviderId, currentModelId]);
}
