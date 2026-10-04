import '@/sync/native-test-network';
import { afterAll, afterEach, expect, test } from 'bun:test';
import { usePermissionStore } from './permissionStore';
import { togglePermissionAutoAccept } from '@/components/chat/permissionAutoAccept';

const previousFetch = globalThis.fetch;
let requests = 0;
globalThis.fetch = async () => {
  requests++;
  throw new Error('Disabled permission store must not reach transport');
};
afterEach(() => {
  usePermissionStore.getState().reset();
  requests = 0;
});
afterAll(() => { globalThis.fetch = previousFetch; });

test('hydration and stored/broadcast policies cannot enable automatic permissions or migrate stored data', async () => {
  const legacy = { root: true, child: false };
  const policy = { root: true };
  usePermissionStore.setState({ autoAccept: policy, legacyCandidate: legacy, legacyRuntimeKey: 'old-runtime' });
  await usePermissionStore.getState().hydrate();
  usePermissionStore.getState().applySnapshot({ sessions: { remote: true }, revision: 99 });
  expect(usePermissionStore.getState().isSessionAutoAccepting('root')).toBe(false);
  expect(usePermissionStore.getState().isSessionAutoAccepting('remote')).toBe(false);
  expect(usePermissionStore.getState().autoAccept).toBe(policy);
  expect(usePermissionStore.getState().legacyCandidate).toBe(legacy);
  expect(usePermissionStore.getState().legacyRuntimeKey).toBe('old-runtime');
  expect(requests).toBe(0);
});

test('enabled enrollment refuses; Off and reset never trigger replies or clear legacy storage', async () => {
  const legacy = { root: true };
  usePermissionStore.setState({ legacyCandidate: legacy });
  await expect(usePermissionStore.getState().setSessionAutoAccept('root', true)).rejects.toThrow(/unsupported/i);
  await usePermissionStore.getState().setSessionAutoAccept('root', false);
  usePermissionStore.getState().reset();
  expect(usePermissionStore.getState().isSessionAutoAccepting('root')).toBe(false);
  expect(usePermissionStore.getState().legacyCandidate).toBe(legacy);
  expect(usePermissionStore.getState().saving).toBe(false);
  expect(requests).toBe(0);
});

for (const mode of ['draft', 'session', 'btw', 'empty'] as const) test(`old ${mode} toggle helper refuses without a local fallback or mutation`, () => {
  let mutations = 0;
  let failures = 0;
  togglePermissionAutoAccept({
    permissionScopeSessionId: mode === 'session' ? 'root' : null,
    newSessionDraftOpen: mode === 'draft',
    draftPermissionAutoAcceptEnabled: true,
    permissionAutoAcceptEnabled: true,
    setDraftPermissionAutoAcceptEnabled: () => { mutations++; },
    setSessionAutoAccept: async () => { mutations++; },
    onOpenSessionFirst: () => { mutations++; },
    onToggleFailed: () => { failures++; },
  });
  expect(mutations).toBe(0);
  expect(failures).toBe(1);
  expect(requests).toBe(0);
});
