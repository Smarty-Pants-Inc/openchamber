import type { Session } from '@opencode-ai/sdk/v2';
import { isLastActiveSession, type PersistedLastSession } from '@/sync/last-session-cache';

export type LastSessionRestoreStep = { kind: 'skip' } | { kind: 'clear' } | { kind: 'restore'; session: Session };

/**
 * The native mobile cold restore, after its session snapshot arrived. The person's intent is checked first
 * (smarty-code#113): a draft action or another selection while the snapshot loaded replaced the captured pointer, and
 * then nothing is restored or cleared (clearing would drop the newer choice's pointer).
 */
export function lastSessionRestoreStep(input: { capturedRuntime: string; currentRuntime: string; persisted: PersistedLastSession;
  activeSessions: readonly Session[]; currentSessionId: string | null; storage?: Storage }): LastSessionRestoreStep {
  const { capturedRuntime, currentRuntime, persisted, activeSessions, currentSessionId, storage } = input;
  if (currentRuntime !== capturedRuntime || !isLastActiveSession(capturedRuntime, persisted.sessionId, storage)) return { kind: 'skip' };
  const session = activeSessions.find(entry => entry.id === persisted.sessionId);
  if (!session) return { kind: 'clear' }; // Gone (deleted or archived): drop the stale pointer, not retry it every launch.
  return currentSessionId ? { kind: 'skip' } : { kind: 'restore', session };
}
