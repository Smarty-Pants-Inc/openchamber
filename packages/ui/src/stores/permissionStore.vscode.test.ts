import '@/sync/native-test-network';
import { afterAll, expect, test } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { nativeComposerDom } from '@/components/chat/composer/submit/__tests__/nativeComposer-dom';

const dom = nativeComposerDom();
Object.defineProperty(window, '__VSCODE_CONFIG__', { value: { workspaceFolder: '/native-project-a' }, configurable: true });
const legacyStoredPolicy = { root: true, child: false };
window.localStorage.setItem('permission-store', JSON.stringify({ state: { autoAccept: legacyStoredPolicy }, version: 1 }));
const { isVSCodeRuntime } = await import('@/lib/desktop');
const { usePermissionStore } = await import('./permissionStore');
const { nativeDraftFixture, directory, session } = await import('@/sync/native-draft-fixture');
const { respondToPermission } = await import('@/sync/session-actions');
const { processVSCodePermissionAutoAccept, processVSCodeReconciledPermissionAutoAccept, reconcileVSCodePendingPermissions } = await import('@/sync/vscode-permission-auto-accept');
afterAll(async () => { await dom.restore(); });

test('actual stored legacy policies stay byte-identical through initialization, hydration and reset', async () => {
  const original = JSON.stringify({ state: { autoAccept: legacyStoredPolicy }, version: 1 });
  expect(window.localStorage.getItem('permission-store')).toBe(original);
  for (const record of [original,
    JSON.stringify({ state: { legacyCandidate: legacyStoredPolicy, legacyRuntimeKey: 'old-runtime' }, version: 2 }),
    '{"state":{"autoAccept":{"root":true,"old":"opaque"}},"version":1}',
  ]) {
    window.localStorage.setItem('permission-store', record);
    await usePermissionStore.getState().hydrate();
    usePermissionStore.getState().applySnapshot({ sessions: { root: true }, revision: 99 });
    usePermissionStore.getState().reset();
    await sleep(0);
    expect(usePermissionStore.getState().autoAccept).toEqual({});
    expect(usePermissionStore.getState().legacyCandidate).toBeNull();
    expect(usePermissionStore.getState().isSessionAutoAccepting('root')).toBe(false);
    expect(window.localStorage.getItem('permission-store')).toBe(record);
  }
});

test('real VS Code store and foreground entrypoints remain inert, but manual replies use the actual scoped SDK', async () => {
  expect(isVSCodeRuntime()).toBe(true);
  const c = nativeDraftFixture();
  const baseFetch = globalThis.fetch;
  const replies: Request[] = [];
  const calls: Request[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push(request.clone());
    if (new URL(request.url).pathname.includes('/permission/')) {
      replies.push(request.clone());
      return Response.json(true);
    }
    return baseFetch(input, init);
  };
  try {
    await sleep(0);
    const before = calls.length;
    const stored = { root: true };
    usePermissionStore.setState({ autoAccept: stored, legacyCandidate: stored });
    await usePermissionStore.getState().hydrate();
    await expect(usePermissionStore.getState().setSessionAutoAccept(session.id, true)).rejects.toThrow(/unsupported/i);
    usePermissionStore.getState().applySnapshot({ sessions: { [session.id]: true }, revision: 999 });
    expect(usePermissionStore.getState().isSessionAutoAccepting(session.id)).toBe(false);
    const permission = { id: 'manual', sessionID: session.id, permission: 'bash', patterns: [], metadata: {}, always: [] };
    expect(await processVSCodePermissionAutoAccept(permission, directory)).toBe(false);
    expect(await processVSCodeReconciledPermissionAutoAccept(permission, directory)).toBe(false);
    await reconcileVSCodePendingPermissions(directory);
    expect(replies).toEqual([]);
    expect(calls).toHaveLength(before);
    expect(usePermissionStore.getState().legacyCandidate).toBe(stored);
    for (const reply of ['once', 'always', 'reject'] as const) {
      await respondToPermission(session.id, 'manual', reply, directory);
    }
    expect(replies).toHaveLength(3);
    for (const [index, reply] of ['once', 'always', 'reject'].entries()) {
      expect(replies[index].method).toBe('POST');
      expect(new URL(replies[index].url).pathname).toBe('/api/permission/manual/reply');
      expect(new URL(replies[index].url).searchParams.get('directory')).toBe(directory);
      expect(await replies[index].json()).toEqual({ reply });
    }
  } finally {
    globalThis.fetch = baseFetch;
    c.dispose();
    usePermissionStore.getState().reset();
  }
});
