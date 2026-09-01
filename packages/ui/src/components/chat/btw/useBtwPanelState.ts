import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { getBtwBoundaryMessageID, getBtwSessionID } from '@/lib/sessionBtwMetadata';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useBtwStore } from '@/stores/useBtwStore';
import { useSession } from '@/sync/sync-context';
export type BtwPanelState = {
  /** The active fork for this parent, or null when no panel should exist. */
  btwSessionId: string | null;
  btwSession: Session | null;
  /** The fork's directory identity (may be canonicalized by the server). */
  btwDirectory: string | null;
  /** Last message id inherited from the parent; the panel shows what's after it. */
  boundaryMessageID: string | null;
  collapsed: boolean;
  creating: boolean;
};

/**
 * Derive the `/btw` panel identity for one parent session from authoritative
 * session metadata (`openchamber.btwSessionID`), the global session index, and
 * the transient UI state kept in `useBtwStore`. The panel uses the linked
 * fork's canonical directory, so a server-canonicalized worktree fork never
 * falls back to the parent's store or request path.
 */
export function useBtwPanelState(
  parentSessionId: string | null | undefined,
  directory: string | undefined,
): BtwPanelState {
  const parentSession = useSession(parentSessionId, directory);
  const linkedBtwSessionId = getBtwSessionID(parentSession);
  const indexedBtwSession = useGlobalSessionsStore(
    React.useCallback(
      (state) => (linkedBtwSessionId ? state.entityById.get(linkedBtwSessionId) ?? null : null),
      [linkedBtwSessionId],
    ),
  );
  const canonicalBtwDirectory = indexedBtwSession
    ? resolveGlobalSessionDirectory(indexedBtwSession)
    : null;
  const btwSession = useSession(linkedBtwSessionId, canonicalBtwDirectory ?? undefined) ?? indexedBtwSession;
  const btwDirectory = btwSession
    ? resolveGlobalSessionDirectory(btwSession) ?? canonicalBtwDirectory
    : null;
  const uiState = useBtwStore(
    React.useCallback(
      (s) => (parentSessionId ? s.byParent[parentSessionId] : undefined),
      [parentSessionId],
    ),
  );

  const destroying = Boolean(uiState?.destroying);
  const btwSessionId = btwSession && btwDirectory && !destroying ? linkedBtwSessionId : null;
  return {
    btwSessionId,
    btwSession: btwSessionId ? btwSession : null,
    btwDirectory: btwSessionId ? btwDirectory : null,
    boundaryMessageID: btwSessionId ? getBtwBoundaryMessageID(btwSession) : null,
    collapsed: Boolean(uiState?.collapsed),
    creating: Boolean(uiState?.creating),
  };
}
