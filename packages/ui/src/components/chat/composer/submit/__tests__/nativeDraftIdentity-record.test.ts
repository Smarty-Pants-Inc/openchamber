import { expect, test } from 'bun:test';
import { match } from 'node:assert/strict';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSessionUIStore } from '@/sync/session-ui-store';

// Test observation only: expected roots/directories are supplied by each case, never mapped here.
export const known = (value: string) => ({ state: 'known', value });
export const none = { state: 'none', value: null };
export const pending = { state: 'pending', value: null };
export function readIdentity(container: ParentNode) {
  const nodes = container.querySelectorAll('[data-testid="native-draft-identity"]');
  expect(nodes).toHaveLength(1);
  const json = nodes[0]?.getAttribute('data-draft-identity');
  if (!json) throw new Error('Common writable composer must publish draft identity JSON');
  const record = JSON.parse(json);
  expect(Object.keys(record).sort()).toEqual(['version', 'runtimeKey', 'draftId', 'target',
    'selectedProjectId', 'requestedDirectory', 'projectRoot', 'directory',
    'nativeTarget', 'state', 'reason'].sort());
  for (const field of [record.projectRoot, record.directory]) {
    expect(Object.keys(field).sort()).toEqual(['state', 'value']);
    expect(['known', 'none', 'pending']).toContain(field.state);
    if (field.state === 'known') match(field.value, /^/);
    else expect(field.value).toBeNull();
  }
  return record;
}

test('contract expectation encodes none and pending as distinct explicit null fields', () => {
  expect(none).toEqual({ state: 'none', value: null });
  expect(pending).toEqual({ state: 'pending', value: null });
  expect(JSON.stringify(none)).not.toBe(JSON.stringify(pending));
  expect(known('/accepted/org')).toEqual({ state: 'known', value: '/accepted/org' });
});

export function expectIdentity(container: ParentNode, expected: {
  state: string; reason: string | null;
  projectRoot: ReturnType<typeof known> | typeof none;
  directory: ReturnType<typeof known> | typeof none;
  nativeTarget: boolean;
}) {
  const draft = useSessionUIStore.getState().newSessionDraft;
  const record = readIdentity(container);
  expect(record).toEqual({ version: 1, runtimeKey: getRuntimeKey(), draftId: draft.draftId,
    target: draft.target, selectedProjectId: !draft.open || draft.target === 'chat' ? null : draft.selectedProjectId ?? null,
    requestedDirectory: draft.directoryOverride ?? null, ...expected });
  return record;
}
