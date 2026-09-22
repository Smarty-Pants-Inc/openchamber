import { afterEach, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { mountedNativeComposer } from './nativeComposer.fixture';
import { directory, session } from '@/sync/native-draft-fixture';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { opencodeClient } from '@/lib/opencode/client';
import { DISPLAY_NAME_KEY } from '@/lib/messages/displayName';
import type { useSyncRuntime } from '@/sync/sync-context';

// Vite-only seams used by managedDraftPresentation; no selection or parent mocks.
mock.module('@/components/chat/markdown/markdown-shiki.worker.ts?worker&url', () => ({ default: 'blob:test-shiki-worker' }));
mock.module('@/hooks/useProviderLogo', () => ({ useProviderLogo: () => { throw new Error('Unexpected model panel'); }, preloadProviderLogos: () => undefined }));
const { ChatContainer } = await import('@/components/chat/ChatContainer');
type RuntimeValue = ReturnType<typeof useSyncRuntime>;
// SAFETY: sync-context publishes these exact context keys; use its runtime contract and check both before rendering.
const globals = globalThis as typeof globalThis & {
  __openchamber_sync_context__?: React.Context<(RuntimeValue & { directory: string }) | null>;
  __openchamber_sync_runtime_context__?: React.Context<RuntimeValue | null>;
};
const System = globals.__openchamber_sync_context__, Runtime = globals.__openchamber_sync_runtime_context__;
let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
let props: Pick<React.ComponentProps<typeof ChatContainer>, 'autoOpenDraft' | 'readOnly'> = {};
let missingControlCommits: boolean[] = [];
const expectedName = 'Kate';
function field() {
  const label = [...(mounted?.dom.container.querySelectorAll('label') ?? [])]
    .find(node => node.textContent === 'Display name for this tab');
  const node = label && mounted?.dom.window.document.getElementById(label.htmlFor);
  return node instanceof mounted!.dom.window.HTMLInputElement ? node : null;
}
function input() {
  const node = field();
  if (!node) throw new Error('Actual display-name input missing');
  return node;
}
function committed() {
  if (mounted) missingControlCommits.push(!field());
}
function parent(fixture: Parameters<NonNullable<Parameters<typeof mountedNativeComposer>[3]>>[0]) {
  if (!System || !Runtime) throw new Error('Actual sync context seam unavailable');
  const runtime: RuntimeValue = { childStores: fixture.children, messageLoader: fixture.loader,
    sdk: opencodeClient.getSdkClient(), runtimeKey: fixture.runtimeA,
    currentDirectory: { get: () => directory, subscribe: () => () => undefined } };
  return <System.Provider value={{ ...runtime, directory }}><Runtime.Provider value={runtime}>
    <React.Profiler id="composer-selection" onRender={committed}>
      <ChatContainer messagesEnabled={false} {...props} />
    </React.Profiler>
  </Runtime.Provider></System.Provider>;
}
afterEach(async () => {
  if (mounted) { const current = mounted; mounted = undefined; await current.dispose(); }
  props = {}; missingControlCommits = [];
});
async function mount() {
  mounted = await mountedNativeComposer(false, undefined, undefined, parent);
  await act(async () => { useProjectsStore.setState({ managedCatalogStatus: 'stock', managedCatalogAdmitted: false }); });
  return mounted;
}
async function fill() {
  const node = input();
  await act(async () => {
    Object.getOwnPropertyDescriptor(mounted!.dom.window.HTMLInputElement.prototype, 'value')!.set!.call(node, expectedName);
    node.dispatchEvent(new mounted!.dom.window.Event('input', { bubbles: true }));
  });
  expect(input().value).toBe(expectedName);
}
const choose = () => useSessionUIStore.getState().setCurrentSession(session.id, directory);
for (const mode of ['selection-before-fill', 'ordinary-render', 'selection-between-fill-and-apply'] as const) {
  test(`composer preserves unapplied name: ${mode}`, async () => {
    const current = await mount();
    expect(useSessionUIStore.getState().currentSessionId).toBeNull();
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true);
    // Initial effects settle before typing. Selection uses the real synchronous store action.
    if (mode === 'selection-before-fill') await act(async () => { choose(); });
    await fill();
    const before = input(), doc = current.dom.window.document, root = current.dom.container;
    expect(current.dom.window.sessionStorage.getItem(DISPLAY_NAME_KEY)).toBeNull();
    missingControlCommits = [];
    if (mode === 'selection-between-fill-and-apply') await act(async () => { choose(); });
    if (mode === 'ordinary-render') await act(async () => current.rerender());
    const after = input();
    // One Apply, even on the failing source; never repair lost input in the test.
    const buttons = [...root.querySelectorAll('button')].filter(button => button.textContent === 'Apply name');
    expect(buttons.length).toBe(1);
    await act(async () => buttons[0]!.click());
    expect(doc).toBe(current.dom.window.document);
    expect(root).toBe(current.dom.container);
    expect(after === before).toBe(true);
    expect(before.isConnected).toBe(true);
    expect(after.value).toBe(expectedName);
    expect(missingControlCommits.some(Boolean)).toBe(false);
    const statuses = (after.getAttribute('aria-describedby') ?? '').split(/\s+/)
      .map(id => doc.getElementById(id)).filter(node => node?.getAttribute('role') === 'status');
    expect(statuses.some(node => node!.textContent?.includes(`New prompts use the display name ${expectedName}.`))).toBe(true);
    expect(current.dom.window.sessionStorage.getItem(DISPLAY_NAME_KEY)).toBe(expectedName);
    expect(after.getAttribute('aria-invalid')).toBe('false');
  });
}

test('explicit draft cancellation retains the legitimate empty state', async () => {
  props = { autoOpenDraft: false };
  const current = await mount();
  const before = input();
  await act(async () => { useSessionUIStore.getState().closeNewSessionDraft(); });
  expect(useSessionUIStore.getState().currentSessionId).toBeNull();
  expect(useSessionUIStore.getState().newSessionDraft.open).toBe(false);
  expect(field()).toBeNull();
  expect(before.isConnected).toBe(false);
  expect(current.dom.container.textContent?.trim().length).toBeGreaterThan(0);
});

test('clearing selection without automatic draft returns to empty state', async () => {
  props = { autoOpenDraft: false };
  const current = await mount();
  await act(async () => { choose(); });
  expect(field()).not.toBeNull();
  await act(async () => { useSessionUIStore.getState().setCurrentSession(null); });
  expect(useSessionUIStore.getState().newSessionDraft.open).toBe(false);
  expect(field()).toBeNull();
  expect(current.dom.container.textContent?.trim().length).toBeGreaterThan(0);
});

test('read-only surface still replaces the selected composer', async () => {
  const current = await mount();
  await act(async () => { choose(); });
  const before = input();
  props = { readOnly: true };
  await act(async () => current.rerender());
  expect(field()).toBeNull();
  expect(before.isConnected).toBe(false);
  props = { readOnly: false };
  await act(async () => current.rerender());
  expect(field()).not.toBeNull();
  expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
});
