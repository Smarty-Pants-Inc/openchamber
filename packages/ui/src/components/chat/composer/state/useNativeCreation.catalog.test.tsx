import React, { act } from 'react';
import { Window } from 'happy-dom';
import { expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { NATIVE_CREATION_INVALIDATED } from '@/lib/opencode/nativeCreation';
import type { NewSessionDraftState } from '@/sync/session-ui-store';

mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
// Operation refresh is covered elsewhere; this test isolates the capability check.
mock.module('@/sync/native-draft-control', () => ({ refreshNativeCreation: async () => {}, replyNativeCreation: async () => {},
  resumeNativeCreation: async () => {}, abandonNativeCreation: async () => false, abandonedNativeCreations: new Set<string>() }));
const { useNativeCreation, NEW_TREE_RETRY_MS } = await import('./useNativeCreation');

type Support = { mode: 'interactive'; clientRequestId: boolean; abandon: boolean };
let failStatus: number | undefined; // The failed check's HTTP status (smarty-code#966); undefined: a transport failure.
// One happy-dom page, the hook mounted on a draft, and the client's capability read replaced (restored afterwards).
async function withDraft(directory: string, admitted: () => boolean, run: (read: () => { mode: string; checks: number },
  update: (patch: Partial<NewSessionDraftState>) => Promise<void>) => Promise<void>, initial: Partial<NewSessionDraftState> = {}) {
  const win = new Window({ url: 'http://localhost' });
  const values = { window: win, document: win.document, navigator: win.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const original = { support: opencodeClient.nativeCreationSupport, list: opencodeClient.listNativeCreations };
  let checks = 0, mode = '';
  const support = async (): Promise<Support> => { checks++; if (!admitted()) throw Object.assign(new Error('403 not admitted'), failStatus === undefined ? {} : { status: failStatus });
    return { mode: 'interactive', clientRequestId: true, abandon: false }; };
  // SAFETY: test doubles with the two capability methods' call shape; restored in finally.
  Object.assign(opencodeClient, { nativeCreationSupport: support, listNativeCreations: async () => [] });
  // SAFETY: a draft with the fields the hook reads.
  let draft = { open: true, draftId: 1, target: 'project', directoryOverride: directory, selectedProjectId: 'owned', ...initial } as NewSessionDraftState;
  const Probe = () => { mode = useNativeCreation(draft, null, undefined, getRuntimeKey()).mode; return null; };
  // SAFETY: happy-dom's element is a DOM element; its type is happy-dom's own, not lib.dom's.
  const root = createRoot(win.document.createElement('div') as unknown as Element);
  try {
    await act(async () => root.render(<Probe />));
    await run(() => ({ mode, checks }), async patch => { draft = { ...draft, ...patch }; await act(async () => root.render(<Probe />)); });
  } finally {
    await act(async () => root.unmount());
    Object.assign(opencodeClient, { nativeCreationSupport: original.support, listNativeCreations: original.list });
    useProjectsStore.getState().resetManagedCatalog();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    await win.happyDOM.close();
  }
}
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

// smarty-code#113 / #126: before managed discovery answers, the directory may not be admitted (gateway 403), so no
// check is sent; once the catalog is ready the check runs, instead of staying on "Cannot check native creation support".
test('native creation support is checked once the managed catalog becomes ready, not before', async () => {
  let admitted = false;
  useProjectsStore.getState().resetManagedCatalog();
  useProjectsStore.setState({ projects: [], managedCatalogStatus: 'unknown' });
  await withDraft('/projects/owned', () => admitted, async (read) => {
    await settle();
    expect([read().mode, read().checks]).toEqual(['discovering', 0]); // "Loading projects…" (G13), never a home-directory check.
    // A first discovery that failed and is retrying is still "discovering": no check against the home fallback (G13).
    await act(async () => useProjectsStore.setState({ managedCatalogStatus: 'unavailable' }));
    await settle();
    expect([read().mode, read().checks]).toEqual(['discovering', 0]);
    admitted = true;
    await act(async () => useProjectsStore.getState().applyManagedCatalog([{ id: 'gateway-owned', worktree: '/projects/owned' }]));
    await settle();
    expect([read().mode, read().checks]).toEqual(['ordinary', 1]);
    // Unavailable AFTER discovery answered keeps the last-known projects: the composer is not sent back to discovering.
    await act(async () => useProjectsStore.setState({ managedCatalogStatus: 'unavailable' }));
    await settle();
    expect(read().mode).not.toBe('discovering');
  });
});

// smarty-code#629: '+ New' worktree binds the draft to the new tree's path before the tree exists; the first check is
// refused (403 not admitted). When the next catalog publication admits the tree, the draft checks again and can Send.
test('a new worktree draft checks again once the catalog admits its tree', async () => {
  let admitted = false;
  useProjectsStore.getState().resetManagedCatalog();
  useProjectsStore.getState().applyManagedCatalog([{ id: 'repo', worktree: '/projects/repo' }]); // Catalog ready, tree absent.
  await withDraft('/worktrees/repo/brave-otter', () => admitted, async (read) => {
    await settle();
    expect([read().mode, read().checks]).toEqual(['unavailable', 1]); // Before the tree exists: refused.
    admitted = true;
    await act(async () => useProjectsStore.getState().applyManagedCatalog([{ id: 'repo', worktree: '/projects/repo' },
      { id: 'brave-otter', worktree: '/worktrees/repo/brave-otter' }])); // The gateway admits the new tree.
    await settle();
    expect([read().mode, read().checks]).toEqual(['ordinary', 2]);
  });
});

// smarty-code#629 on the public candidate: the first check of a just-made tree is refused ("not admitted") until the
// gateway admits it a moment later. The draft checks again shortly and never says the server is unreachable meanwhile.
/**
 * The hook's new-tree rechecks, held (smarty-code#996): each NEW_TREE_RETRY_MS delay is a sentinel no other timer uses,
 * so a recheck runs only when the test fires it (`fire()`), never because wall-clock time passed. The test's 20 ms
 * settle and a 30 ms retry raced on a slow runner (runs 36489154134, 36566158491: checks 2, expected 1).
 */
const holdRetries = () => {
  const original = globalThis.setTimeout, held: Array<() => void> = [];
  const HOLD = [101_001, 101_002, 101_003, 101_004];
  NEW_TREE_RETRY_MS.splice(0, NEW_TREE_RETRY_MS.length, ...HOLD);
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (!HOLD.includes(ms ?? -1)) return original(callback, ms, ...args);
    let live = true; held.push(() => { if (live) { live = false; callback(...args); } });
    const handle = original(() => {}, 2 ** 31 - 1); (handle as { unref?: () => void }).unref?.();
    cleared.set(handle as unknown as number, () => { live = false; }); // a cleared recheck never runs (replaced or cancelled)
    return handle;
  }) as typeof setTimeout;
  const cleared = new Map<number, () => void>(), originalClear = globalThis.clearTimeout;
  globalThis.clearTimeout = ((id?: Parameters<typeof clearTimeout>[0]) => { cleared.get(id as unknown as number)?.(); originalClear(id); }) as typeof clearTimeout;
  return {
    /** Runs every recheck that is due now (not cleared), as their timers would, and lets React commit. */
    fire: () => act(async () => { for (const run of held.splice(0)) run(); await new Promise(resolve => original(resolve, 0)); }),
    pending: () => held.length,
    restore: () => { globalThis.setTimeout = original; globalThis.clearTimeout = originalClear;
      NEW_TREE_RETRY_MS.splice(0, NEW_TREE_RETRY_MS.length, 1_000, 2_000, 4_000, 8_000); },
  };
};

test('a just-made worktree that the gateway has not admitted yet is checked again, not reported offline', async () => {
  let admitted = false;
  const retries = holdRetries();
  useProjectsStore.getState().resetManagedCatalog();
  useProjectsStore.getState().applyManagedCatalog([{ id: 'repo', worktree: '/projects/repo' }]);
  const tree = '/worktrees/repo/zealous-egret';
  try {
    await withDraft(tree, () => admitted, async (read) => {
      await settle();
      expect([read().mode, read().checks]).toEqual(['loading', 1]); // Refused once: waiting, not "offline".
      admitted = true;
      await retries.fire(); await settle();
      expect([read().mode, read().checks]).toEqual(['ordinary', 2]);
    }, { bootstrapPendingDirectory: tree });
    // Another directory refused the same way is reported at once, and a new tree still refused after the retries is too.
    admitted = false;
    const ready = () => useProjectsStore.getState().applyManagedCatalog([{ id: 'repo', worktree: '/projects/repo' }]);
    ready();
    await withDraft('/projects/other', () => admitted, async (read) => { await settle(); expect(read().mode).toBe('unavailable'); });
    ready();
    NEW_TREE_RETRY_MS.splice(2); // two retries, as the old test's two delays
    await withDraft(tree, () => false, async (read) => {
      await settle();
      for (let i = 0; i < 2; i++) { await retries.fire(); await settle(); }
      expect([read().mode, read().checks]).toEqual(['unavailable', 3]);
    }, { bootstrapPendingDirectory: tree });
    // An invalidation during the wait replaces the pending recheck: one chain of rechecks, never two (a second chain's
    // timer would outlive its cleanup).
    ready();
    await withDraft(tree, () => false, async (read) => {
      await settle(); // Refused once; a recheck is pending.
      await act(async () => { window.dispatchEvent(new CustomEvent(NATIVE_CREATION_INVALIDATED, { detail: { runtimeKey: getRuntimeKey() } })); });
      await settle();
      for (let i = 0; i < 2; i++) { await retries.fire(); await settle(); }
      // 1 + the invalidation's check + 1 retry (the retry budget is shared) = 3; a second, orphaned chain made it 4.
      expect(read().checks).toBe(3);
    }, { bootstrapPendingDirectory: tree });
  } finally { retries.restore(); }
});

// smarty-code#629 on a candidate: the gateway admits the new tree when a request names it, and nothing re-reads the
// catalog before Send. A check while '+ New' is still making the tree was refused and stayed "Cannot reach the server";
// no check runs until the tree is made, and then the one check (it names the tree) succeeds.
test('a new worktree draft checks only once its tree is made, and that check succeeds', async () => {
  let made = false;
  useProjectsStore.getState().resetManagedCatalog();
  useProjectsStore.getState().applyManagedCatalog([{ id: 'repo', worktree: '/projects/repo' }]); // Catalog ready, tree absent.
  await withDraft('/worktrees/repo/lucid-narwhal', () => made, async (read, update) => {
    await settle();
    expect(read().checks).toBe(0); // Still being made: no check, so no refusal.
    expect(read().mode).not.toBe('unavailable');
    made = true;
    await update({ pendingWorktreeRequestId: null }); // '+ New' has made the tree.
    await settle();
    expect([read().mode, read().checks]).toEqual(['ordinary', 1]);
  }, { pendingWorktreeRequestId: 'worktree_1', bootstrapPendingDirectory: '/worktrees/repo/lucid-narwhal' });
});

test('discoveryPendingFor: unknown, or unavailable before any answer; never after an answer (G13)', async () => {
  const { discoveryPendingFor } = await import('./useNativeCreation');
  expect(discoveryPendingFor('unknown', false)).toBe(true);
  expect(discoveryPendingFor('unavailable', false)).toBe(true);
  expect(discoveryPendingFor('unavailable', true)).toBe(false);
  expect(discoveryPendingFor('ready', true)).toBe(false);
  expect(discoveryPendingFor('stock', true)).toBe(false);
});

test('discovery counts as answered after a stock answer too, even when a later refresh is unavailable (G13)', async () => {
  const { discoveryAnswered } = await import('@/lib/managed-discovery');
  expect(discoveryAnswered({ managedCatalogStatus: 'unavailable', managedCatalogStockConfirmed: true, managedRows: null })).toBe(true);
  expect(discoveryAnswered({ managedCatalogStatus: 'unavailable', managedCatalogStockConfirmed: false, managedRows: [] })).toBe(true);
  expect(discoveryAnswered({ managedCatalogStatus: 'unavailable', managedCatalogStockConfirmed: false, managedRows: null })).toBe(false);
});

// smarty-code#966: a remembered project that the ready catalog no longer admits answers 403 "Project is not configured".
// The composer says the project is gone (choose another), never "Cannot reach the server"; a real transport failure still does.
test('a remembered project the ready catalog does not admit says so, not "Cannot reach the server"', async () => {
  useProjectsStore.getState().resetManagedCatalog();
  useProjectsStore.getState().applyManagedCatalog([{ id: 'repo', worktree: '/projects/repo' }]); // Ready; the remembered one absent.
  failStatus = 403;
  try {
    await withDraft('/old/candidate/project', () => false, async (read) => { await settle(); expect(read().mode).toBe('notAdmitted'); });
    failStatus = undefined; // Counterexample: no answer at all (the server is unreachable).
    useProjectsStore.getState().applyManagedCatalog([{ id: 'repo', worktree: '/projects/repo' }]);
    await withDraft('/old/candidate/project', () => false, async (read) => { await settle(); expect(read().mode).toBe('unavailable'); });
  } finally { failStatus = undefined; }
});

// openchamber#441 review 1: a just-made '+ New' tree refused with an actual 403 (not yet admitted) keeps its rechecks
// first, and is not "no longer available" while they run.
test('a just-made tree refused with 403 is rechecked, not reported gone; only after the rechecks is it gone', async () => {
  let admitted = false;
  const retries = holdRetries();
  const tree = '/worktrees/repo/brisk-heron';
  failStatus = 403;
  try {
    useProjectsStore.getState().resetManagedCatalog();
    useProjectsStore.getState().applyManagedCatalog([{ id: 'repo', worktree: '/projects/repo' }]);
    await withDraft(tree, () => admitted, async (read) => {
      await settle();
      expect([read().mode, read().checks]).toEqual(['loading', 1]); // A recheck is pending, not 'notAdmitted'.
      admitted = true;
      await retries.fire(); await settle();
      expect([read().mode, read().checks]).toEqual(['ordinary', 2]);
    }, { bootstrapPendingDirectory: tree });
    useProjectsStore.getState().applyManagedCatalog([{ id: 'repo', worktree: '/projects/repo' }]);
    NEW_TREE_RETRY_MS.splice(2);
    await withDraft(tree, () => false, async (read) => {
      await settle();
      for (let i = 0; i < 2; i++) { await retries.fire(); await settle(); }
      expect([read().mode, read().checks]).toEqual(['notAdmitted', 3]); // Never admitted after its rechecks.
    }, { bootstrapPendingDirectory: tree });
  } finally { failStatus = undefined; retries.restore(); }
});
