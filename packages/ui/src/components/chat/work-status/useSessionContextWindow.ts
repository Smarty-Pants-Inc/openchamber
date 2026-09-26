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
  const ordinary = readOrdinaryModel(session ?? undefined)?.model;
  const ordinaryProvider = ordinary?.providerID;
  const ordinaryModel = ordinary?.modelID;
  return React.useMemo(() => sessionContextWindow(providers,
    ordinaryProvider && ordinaryModel ? { providerID: ordinaryProvider, modelID: ordinaryModel } : null,
    messages as unknown as Parameters<typeof sessionContextWindow>[2],
    currentProviderId && currentModelId ? { providerID: currentProviderId, modelID: currentModelId } : null),
  [providers, ordinaryProvider, ordinaryModel, messages, currentProviderId, currentModelId]);
}
