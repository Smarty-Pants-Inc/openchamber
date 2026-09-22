import { afterEach, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
// Installs the existing synthetic network, DOM and unrelated leaf mocks FIRST.
import { mountedNativeComposer } from './nativeComposer.fixture';
import { directory } from '@/sync/native-draft-fixture';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';

// Same Bun URL-import seam as markdown-worker.hang.test; no message renderer is mounted.
mock.module('@/components/chat/markdown/markdown-shiki.worker.ts?worker&url', () => ({ default: 'blob:test-shiki-worker' }));
// Vite-only logo imports belong to unmounted model/message panels, not these headings.
mock.module('@/hooks/useProviderLogo', () => ({
  useProviderLogo: () => { throw new Error('Provider logo panel must not mount in draft proof'); },
  preloadProviderLogos: () => undefined,
}));
// Actual product component and hook, never a copied selector or UI replica.
const { DraftWelcome } = await import('@/components/chat/ChatContainer');
const { useDraftTarget } = await import('../../state/useDraftTarget');
let selectedTarget: ReturnType<typeof useDraftTarget>['selectedDraftProject'] | null = null;
function TargetProbe() {
  selectedTarget = useDraftTarget(false).selectedDraftProject;
  return null;
}
const surfaces = <>
  <section data-testid="actual-draft-welcome"><DraftWelcome /></section>
  <TargetProbe />
</>;
const savedA = { id: 'a', path: directory, label: 'Saved Alpha' };
const savedB = { id: 'b', path: '/native-project-b', label: 'Retained Bravo' };
let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
afterEach(async () => { await mounted?.dispose(); mounted = undefined; });
const settle = () => sleep(0);
const welcome = () => {
  const heading = mounted?.dom.container.querySelector('[data-testid="actual-draft-welcome"] h1');
  expect(heading).not.toBeNull();
  return heading?.textContent;
};
const composerHeading = () => {
  const heading = mounted?.dom.container.querySelector('form h1');
  expect(heading).not.toBeNull();
  return heading?.textContent;
};
async function mount() {
  const c = mounted = await mountedNativeComposer(false, undefined, surfaces);
  await act(async () => {
    useUIStore.setState({ isExpandedInput: false });
    useProjectsStore.setState({ projects: [savedA, savedB], activeProjectId: 'a',
      managedCatalogAdmitted: false, managedCatalogStatus: 'stock', managedProjects: null, managedRows: null });
    await settle();
  });
  return c;
}

for (const present of [true, false]) test(`global New session uses only admitted project targets (membership ${present})`, async () => {
  const c = await mount();
  const creates = c.creates().length;
  await act(async () => {
    // Same no-options action as the global sidebar button, with no saved project
    // target and a current directory outside the authoritative catalog.
    getDeferredSafeStorage().removeItem('oc.chatInput.lastDraftTarget');
    useProjectsStore.setState({ activeProjectId: present ? 'a' : null,
      managedCatalogAdmitted: true, managedCatalogStatus: 'ready',
      managedProjects: present ? [savedA] : [],
      managedRows: present ? [{ id: 'gateway-a', worktree: directory }] : [] });
    useDirectoryStore.setState({ currentDirectory: '/not-admitted' });
    useSessionUIStore.getState().openNewSessionDraft();
    await settle();
  });
  const draft = useSessionUIStore.getState().newSessionDraft;
  expect(draft.target).toBe('project');
  expect(draft.selectedProjectId).toBe(present ? 'a' : null);
  expect(draft.directoryOverride).toBe(present ? directory : null);
  expect(selectedTarget?.id ?? null).toBe(present ? 'a' : null);
  if (present) {
    expect(composerHeading()).toContain('Saved Alpha');
    const create = [...c.dom.container.querySelectorAll('button')].find(button => button.textContent === 'Create native Pi session');
    expect(create).toBeDefined();
    expect(create?.disabled).toBe(false);
  }
  expect(c.creates()).toHaveLength(creates);
  expect(c.prompts()).toHaveLength(0);
  expect(c.requests.filter(request => new URL(request.url).pathname.includes('/chats'))).toHaveLength(0);
});

test('actual heading and composer cannot advertise saved A after authoritative managed empty', async () => {
  const c = await mount();
  await c.replace('Keep this draft');
  const before = useSessionUIStore.getState().newSessionDraft;
  await act(async () => {
    useProjectsStore.setState({ projects: [savedA], activeProjectId: null,
      managedCatalogAdmitted: true, managedCatalogStatus: 'ready', managedProjects: [], managedRows: [] });
    await settle();
  });
  expect(welcome()).not.toContain('Saved Alpha');
  expect(composerHeading()).not.toContain('Saved Alpha');
  // No implicit Chat target, even if its generic heading would look identical.
  expect(selectedTarget?.kind).not.toBe('chat');
  expect(useProjectsStore.getState().projects).toEqual([savedA]);
  expect(useSessionUIStore.getState().newSessionDraft).toEqual(before);
  expect(c.text()).toBe('Keep this draft');
  expect(c.prompts()).toHaveLength(0);
});

test('actual composer preserves retained B on removal instead of advertising or selecting A/chat', async () => {
  const c = await mount();
  await act(async () => {
    useProjectsStore.setState({ managedCatalogAdmitted: true, managedCatalogStatus: 'ready',
      managedProjects: [savedA, savedB], managedRows: [
        { id: 'gateway-a', worktree: savedA.path }, { id: 'gateway-b', worktree: savedB.path },
      ] });
    c.target('b', savedB.path);
    await settle();
  });
  expect(selectedTarget?.id).toBe('b');
  expect(composerHeading()).toContain('Retained Bravo');
  await c.replace('Unsent text for B');
  const before = useSessionUIStore.getState().newSessionDraft;
  const createsBefore = c.creates().length;
  await act(async () => {
    useProjectsStore.setState({ activeProjectId: 'a', managedProjects: [savedA],
      managedRows: [{ id: 'gateway-a', worktree: savedA.path }] });
    await settle();
  });
  expect(selectedTarget?.id).not.toBe('a');
  expect(selectedTarget?.kind).not.toBe('chat');
  expect(composerHeading()).not.toContain('Saved Alpha');
  expect(welcome()).not.toContain('Saved Alpha');
  expect(useSessionUIStore.getState().newSessionDraft).toEqual(before);
  expect(useSessionUIStore.getState().newSessionDraft.selectedProjectId).toBe('b');
  expect(useSessionUIStore.getState().newSessionDraft.directoryOverride).toBe(savedB.path);
  expect(c.text()).toBe('Unsent text for B');
  expect(c.creates()).toHaveLength(createsBefore);
  expect(c.prompts()).toHaveLength(0); // This suite does not exercise native Send.
});

test('stock actual heading/composer keep the existing A fallback', async () => {
  const c = await mount();
  await act(async () => {
    useProjectsStore.setState({ projects: [savedA], activeProjectId: null });
    useSessionUIStore.setState(state => ({ newSessionDraft: {
      ...state.newSessionDraft, selectedProjectId: null,
    } }));
    await settle();
  });
  expect(welcome()).toContain('Saved Alpha');
  expect(composerHeading()).toContain('Saved Alpha');
  expect(selectedTarget?.id).toBe('a');
  expect(useProjectsStore.getState().managedCatalogAdmitted).toBe(false);
  expect(c.prompts()).toHaveLength(0);
});
