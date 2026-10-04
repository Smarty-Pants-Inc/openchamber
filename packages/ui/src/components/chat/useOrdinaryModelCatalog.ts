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
  target: { sessionId: string; directory: string } | undefined, state: OrdinaryModelState, reloading: boolean,
) {
  const sessionId = target?.sessionId, directory = target?.directory;
  const current = state.model;
  const available = Boolean(current) && !reloading;
  const targetKey = JSON.stringify([getRuntimeKey(), directory, sessionId]);
  // Recovery and native generation changes invalidate even an overlapping successful catalog before it can paint.
  const key = JSON.stringify([targetKey, state.generation, available]);
  const readTarget = React.useRef<string | null>(null);
  const [snapshot, setSnapshot] = React.useState<Catalog | null>(null);
  const [revision, refresh] = React.useReducer((n: number) => n + 1, 0);
  const retry = React.useRef({ key, attempted: false });
  const catalog: Catalog = snapshot?.key === key ? snapshot : { key, status: 'loading' };
  const options = catalog.status === 'ready' ? catalog.options : EMPTY_OPTIONS;
  const missing = Boolean(current && !options.some(option => option.key === ordinaryOptionKey(current.providerID, current.modelID)));

  React.useEffect(() => {
    if (!sessionId || !directory) return;
    if (retry.current.key !== key) retry.current = { key, attempted: false };
    // Keep the initial read, but an outage is not a reason to poll. Read again only when native state recovers.
    if (readTarget.current === targetKey && !available) {
      setSnapshot({ key, status: reloading ? 'loading' : 'unavailable' });
      return;
    }
    readTarget.current = targetKey;
    let cancelled = false;
    const scope = captureRuntimeRequestScope();
    setSnapshot({ key, status: 'loading' });
    opencodeClient.getProvidersForConfig(directory, sessionId).then(result => {
      if (cancelled || !isRuntimeRequestScopeCurrent(scope)) return;
      // A reply without a provider list is no catalog: say Unavailable, never throw out of the read (#498 CI).
      if (!Array.isArray(result?.providers)) { setSnapshot({ key, status: 'unavailable' }); return; }
      const choices = buildOrdinaryModelOptions(result.providers.map(provider => ({
        id: provider.id, models: Object.values(provider.models),
      })));
      setSnapshot({ key, status: 'ready', options: choices });
    }, () => {
      if (!cancelled && isRuntimeRequestScopeCurrent(scope)) setSnapshot({ key, status: 'unavailable' });
    });
    return () => { cancelled = true; };
  }, [sessionId, directory, targetKey, key, available, reloading, revision]);

  // The session may not have been live when its catalog was read. Refresh once, only after a successful read.
  React.useEffect(() => {
    if (!sessionId || !directory || !available || catalog.status !== 'ready' || !missing || retry.current.attempted) return;
    retry.current.attempted = true;
    refresh();
  }, [sessionId, directory, available, catalog.status, missing]);

  return { status: catalog.status, options };
}
