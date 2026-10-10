import { afterEach, beforeEach, expect, jest, spyOn, test } from 'bun:test';
import { act } from 'react';
import { create } from 'zustand';
import { setTimeout as sleep } from 'node:timers/promises';
import { mountedNativeComposer } from './nativeComposer.fixture';
import { directory, session } from '@/sync/native-draft-fixture';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { opencodeClient } from '@/lib/opencode/client';
import { toast } from '@/components/ui/toast';
import { resetGoneSessionNotices } from '@/sync/gone-session-notice';
import { setSyncRefs } from '@/sync/sync-refs';
import { INITIAL_STATE, type State } from '@/sync/types';
import { clearSessionReadFailures, isSessionGone } from '@/sync/terminal-session-reads';
import { isHerdrEnded } from '@/lib/herdrSession';

// smarty-code#1575: an open session the listing left out (kept, unavailable, #600) was read every 2 s while unavailable
// (about every 45 s in a hidden tab), and the gateway answered 404 "Unknown Pi session in requested project" forever.
// The first 404 now makes it gone: the #811/#913 ended state, the notice once, and no more reads until listed again.
const GATEWAY = 'Unknown Pi session in requested project';
const DEFAULT = 'This session is no longer available: its Pi ended or its worktree was removed.';
let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
const shown: string[] = [];
let status = 404, reads = 0;
const spies: { mockRestore(): void }[] = [];
beforeEach(() => {
  shown.length = 0; reads = 0; status = 404; resetGoneSessionNotices(); clearSessionReadFailures();
  spies.push(spyOn(toast, 'warning').mockImplementation(message => { shown.push(String(message)); return 'toast'; }));
});
afterEach(async () => {
  jest.useRealTimers();
  await mounted?.dispose(); mounted = undefined; spies.splice(0).forEach(spy => spy.mockRestore());
});

test('the open session\'s 404 is terminal: one read, one notice, the ended state, and no read in the next 10 minutes', async () => {
  const c = mounted = await mountedNativeComposer(true);
  await c.replace('One accepted input'); await c.submit(); await act(() => sleep(0));
  expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
  // The directory store refreshSessionRecord writes into (this fixture mounts no SyncProvider).
  const child = create<State>(() => ({ ...INITIAL_STATE }));
  const manager: Parameters<typeof setSyncRefs>[1] = Object.assign(Object.create(null), {
    children: new Map([[directory, child]]), getChild: () => child, ensureChild: () => child, getState: () => child.getState() });
  setSyncRefs(Object.create(null), manager, directory);
  // From here the gateway answers this session's read: 404 "Unknown Pi session in requested project" (or, later, 200).
  spies.push(spyOn(opencodeClient.getScopedSdkClient(directory).session, 'get').mockImplementation(async () => {
    reads++;
    return status === 200 ? { data: session, error: undefined, request: new Request('http://x'), response: new Response(null, { status }) }
      : { data: undefined, error: { name: 'NotFoundError' as const, data: { message: GATEWAY } }, request: new Request('http://x'), response: new Response(null, { status }) };
  }));
  jest.useFakeTimers();
  // One listing leaves the open session out while its project stays listed: kept open, unavailable (#600).
  await act(async () => {
    useGlobalSessionsStore.getState().applyManagedSessions([], useGlobalSessionsStore.getState().mutationRevision, new Set([directory]));
  });
  expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
  for (let second = 0; second < 600; second++) await act(async () => { jest.advanceTimersByTime(1_000); });
  expect(reads).toBe(1);
  expect(shown).toEqual([DEFAULT]);
  expect(isSessionGone(directory, session.id)).toBe(true);
  expect(isHerdrEnded(useGlobalSessionsStore.getState().entityById.get(session.id))).toBe(true);
  // A later listing that still leaves it out keeps it gone and says nothing again.
  await act(async () => {
    useGlobalSessionsStore.getState().applyManagedSessions([], useGlobalSessionsStore.getState().mutationRevision, new Set([directory]));
    jest.advanceTimersByTime(60_000);
  });
  expect(reads).toBe(1);
  expect(shown).toEqual([DEFAULT]);

  // Counterexample: a listing that names it again clears the mark (its row is no longer ended); a 200 reads it as live.
  status = 200;
  await act(async () => {
    useGlobalSessionsStore.getState().applyManagedSessions([session], useGlobalSessionsStore.getState().mutationRevision, new Set([directory]));
  });
  expect(isSessionGone(directory, session.id)).toBe(false);
  expect(isHerdrEnded(useGlobalSessionsStore.getState().entityById.get(session.id))).toBe(false);
  const { refreshSessionRecord } = await import('@/sync/sync-context');
  await act(async () => { await refreshSessionRecord(session.id, directory); });
  expect(reads).toBe(2);
  expect(child.getState().session.map(entry => entry.id)).toEqual([session.id]);
});
