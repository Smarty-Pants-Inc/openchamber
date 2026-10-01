import React from 'react';
import { opencodeClient } from '@/lib/opencode/client';
import type { OrdinaryModelState } from '@/lib/opencode/ordinaryModel';
import { captureRuntimeRequestScope, getRuntimeKey, isRuntimeRequestScopeCurrent } from '@/lib/runtime-switch';
import { buildOrdinaryModelOptions, ordinaryOptionKey, type OrdinaryModelOption } from './ordinaryModelOptions';

type Catalog = { key: string; status: 'loading' | 'unavailable' }
  | { key: string; status: 'ready'; options: OrdinaryModelOption[] };
const EMPTY_OPTIONS: OrdinaryModelOption[] = [];

/** Only the target session's catalog may populate its picker. No project-store fallback or retained-session cache. */
export function useOrdinaryModelCatalog(
  target: { sessionId: string; directory: string } | undefined, current: OrdinaryModelState['model'],
) {
  const sessionId = target?.sessionId, directory = target?.directory;
  const key = JSON.stringify([getRuntimeKey(), directory, sessionId]);
  const [snapshot, setSnapshot] = React.useState<Catalog | null>(null);
  const [revision, refresh] = React.useReducer((n: number) => n + 1, 0);
  const retry = React.useRef({ key, attempted: false });
  const catalog: Catalog = snapshot?.key === key ? snapshot : { key, status: 'loading' };
  const options = catalog.status === 'ready' ? catalog.options : EMPTY_OPTIONS;
  const missing = Boolean(current && !options.some(option => option.key === ordinaryOptionKey(current.providerID, current.modelID)));

  React.useEffect(() => {
    if (!sessionId || !directory) return;
    if (retry.current.key !== key) retry.current = { key, attempted: false };
    let cancelled = false;
    const scope = captureRuntimeRequestScope();
    setSnapshot({ key, status: 'loading' });
    opencodeClient.getProvidersForConfig(directory, sessionId).then(result => {
      if (cancelled || !isRuntimeRequestScopeCurrent(scope)) return;
      const choices = buildOrdinaryModelOptions(result.providers.map(provider => ({
        id: provider.id, models: Object.values(provider.models),
      })));
      setSnapshot({ key, status: 'ready', options: choices });
    }, () => {
      if (!cancelled && isRuntimeRequestScopeCurrent(scope)) setSnapshot({ key, status: 'unavailable' });
    });
    return () => { cancelled = true; };
  }, [sessionId, directory, key, revision]);

  // The session may not have been live when its catalog was read. Refresh once, only after a successful read.
  React.useEffect(() => {
    if (!sessionId || !directory || catalog.status !== 'ready' || !missing || retry.current.attempted) return;
    retry.current.attempted = true;
    refresh();
  }, [sessionId, directory, catalog.status, missing]);

  return { status: catalog.status, options };
}
