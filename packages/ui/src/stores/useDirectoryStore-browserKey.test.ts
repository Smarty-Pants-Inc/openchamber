import { expect, test } from 'bun:test';
import { BROWSER_LAST_DIRECTORY_KEY, seedBrowserLastDirectory } from './useDirectoryStore';

const storage = (values: Record<string, string>) => ({
  values, getItem: (key: string) => values[key] ?? null, setItem: (key: string, value: string) => { values[key] = value; },
});

// #113 upgrade path: a browser without the key keeps its remembered draft target, never the shared value.
test('an upgrading browser seeds its own last directory from the remembered draft target, then local lastDirectory', () => {
  const fromDraft = storage({ 'oc.chatInput.lastDraftTarget': JSON.stringify({ projectId: 'c', directory: '/repo/.worktrees/child', target: 'project' }),
    lastDirectory: '/repo' });
  seedBrowserLastDirectory(fromDraft);
  expect(fromDraft.values[BROWSER_LAST_DIRECTORY_KEY]).toBe('/repo/.worktrees/child');
  const chatDraft = storage({ 'oc.chatInput.lastDraftTarget': JSON.stringify({ projectId: null, directory: null, target: 'chat' }), lastDirectory: '/repo' });
  seedBrowserLastDirectory(chatDraft);
  expect(chatDraft.values[BROWSER_LAST_DIRECTORY_KEY]).toBe('/repo');
  const existing = storage({ [BROWSER_LAST_DIRECTORY_KEY]: '/mine', lastDirectory: '/repo' });
  seedBrowserLastDirectory(existing);
  expect(existing.values[BROWSER_LAST_DIRECTORY_KEY]).toBe('/mine');
});
