import { expect, mock, test } from 'bun:test';
import * as React from 'react';
import { renderToString } from 'react-dom/server';

// smarty-code#536 (Astra pre-check): Try again after a failed open must reload the history now, even while the
// session's detail read (session.get, with its own tries) is still out; the in-flight dedup returned that old promise.
const ensures: Array<{ force?: boolean }> = [];
const state = { session: [], message: {}, part: {}, sessionEventRevision: {} };
const store = { getState: () => state, setState: () => undefined };
mock.module('./sync-context', () => ({
  dropCachedSessionMessageRecordsSnapshots: () => undefined,
  useChildStoreManager: () => ({ ensureChild: () => store, children: new Map([['/project', store]]) }),
  useDirectoryStore: () => store,
  useSessionMessageLoader: () => ({ ensure: async (_target: { directory: string; sessionID: string }, options: { force?: boolean }) => { ensures.push(options); } }),
  useSyncDirectory: () => '/project',
  useSyncSDK: () => ({ session: { get: () => new Promise(() => {}) } }), // The detail read never answers.
  useSyncRuntime: () => ({}),
  resyncBlockingRequestsForDirectory: async () => undefined,
  recoverInterruptedTurnAfterMessageLoad: async () => undefined,
  buildSessionMessageRecordsSnapshot: () => [],
}));

test('Try again reloads the history while the first open is still waiting on the session detail', async () => {
  const { useSync } = await import('./use-sync');
  let sync: ReturnType<typeof useSync> | undefined;
  const Probe = () => { sync = useSync(); return null; };
  renderToString(<Probe />);
  void sync!.syncSession('ses_frozen'); // The open: detail read out, history read fails (not modeled here).
  await Promise.resolve();
  const before = ensures.length;
  void sync!.syncSession('ses_frozen', true); // Try again.
  await Promise.resolve();
  expect(ensures.length).toBe(before + 1);
  expect(ensures.at(-1)?.force).toBe(true);
});
