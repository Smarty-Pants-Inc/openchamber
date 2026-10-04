import '@/sync/native-test-network';
import React, { act } from 'react';
import { mock, spyOn } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import theme from '@/lib/theme/themes/openchamber-dark.json';
import { nativeComposerDom } from './nativeComposer-dom';

// Unrelated panels/platform readers stay out of this focused DOM test. The composer,
// CodeMirror, draft hook, stores, SDK, history loader and actual send path are NOT mocked.
const leaves = {
  '@/components/dictation/ComposerDictation': ['ComposerDictation'],
  '@/components/session/ReviewFlowDialog': ['ReviewFlowDialog'],
  '@/components/chat/btw/BtwPanel': ['BtwPanel'],
  '@/components/chat/FileAttachment': ['AttachedFilesList', 'AttachedVSCodeFileChips', 'ActiveEditorFileSuggestion', 'MessageFilesDisplay'],
  '@/components/chat/QueuedMessageChips': ['QueuedMessageChips'],
  '@/components/chat/AutoReviewBanner': ['AutoReviewBanner'],
  '@/components/chat/ModelControls': ['ModelControls', 'NativeDraftModelControls'],
  '@/components/chat/ComposerStatusBar': ['ComposerStatusBar'],
  '@/components/chat/PendingChangesBar': ['PendingChangesBar'],
  '@/components/chat/MobileAgentButton': ['MobileAgentButton'],
  '@/components/chat/MobileModelButton': ['MobileModelButton'],
  '@/components/session/GitHubIssuePickerDialog': ['GitHubIssuePickerDialog'],
  '@/components/session/GitHubPrPickerDialog': ['GitHubPrPickerDialog'],
  '@/components/session/LinearIssuePickerDialog': ['LinearIssuePickerDialog'],
  '@/components/chat/DraftPresetChips': ['DraftPresetChips'],
  '@/components/chat/composer/ui/DraftTargetSelectors': ['DraftTargetSelectors', 'MobileDraftTargetSheets', 'MobileDraftTargetTriggers'],
  '@/components/chat/composer/ui/ComposerAutocompletePopups': ['ComposerAutocompletePopups'],
  '@/components/chat/composer/ui/ComposerContextChips': ['ComposerContextChips'],
  '@/components/chat/composer/ui/LinkedReferenceRow': ['LinkedReferenceRow'],
  '@/components/chat/composer/ui/RevertedMessageDock': ['RevertedMessageDock'],
  '@/components/chat/SessionSuggestionChip': ['SessionSuggestionChip'],
  '@/components/chat/SessionGoalRow': ['SessionGoalRow'],
};
for (const [module, exports] of Object.entries(leaves)) mock.module(module, () => Object.fromEntries(exports.map(name => [name, () => null])));
mock.module('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({}) }));
mock.module('@/contexts/useThemeSystem', () => ({ useThemeSystem: () => ({ currentTheme: theme }), useOptionalThemeSystem: () => null }));
/** The current session's shown activity; a test may set 'busy' (a mounted composer re-renders to read it). */
export const shownActivity: { phase: 'idle' | 'busy' } = { phase: 'idle' };
mock.module('@/hooks/useSessionActivity', () => ({ useSessionActivity: () => ({ phase: 'idle' }), useCurrentSessionActivity: () => ({ phase: shownActivity.phase }) }));
export const errors: string[] = [];
const bootstrap = nativeComposerDom();
const bootstrapFetch = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 404 }));
const { toast } = await import('@/components/ui');
spyOn(toast, 'error').mockImplementation(message => { errors.push(String(message)); return 'test-toast'; });
spyOn(toast, 'success').mockImplementation(() => 'test-toast');
const { createRoot } = await import('react-dom/client');
const { EditorView } = await import('@codemirror/view');
const sync = await import('@/sync/sync-context');
type SyncRuntime = ReturnType<typeof sync.useSyncRuntime>;
// SAFETY: sync-context declares these exact shared globals; derive their value
// from its public hook and supply only the existing fixture's real owners.
const globals: typeof globalThis & {
  __openchamber_sync_context__?: React.Context<(SyncRuntime & { directory: string }) | null>;
  __openchamber_sync_runtime_context__?: React.Context<SyncRuntime | null>;
} = globalThis;
const { opencodeClient } = await import('@/lib/opencode/client');
const { getRuntimeKey } = await import('@/lib/runtime-switch');
const btwPanel = await import('@/components/chat/btw/useBtwPanelState');
// A receiver integration test can restore the actual hook; ordinary fixture
// consumers keep their existing inactive-BTW baseline.
export const btwPanelSpy = spyOn(btwPanel, 'useBtwPanelState');
btwPanelSpy.mockReturnValue({
  collapsed: true, btwSessionId: null, btwDirectory: null, parentSession: null,
  btwSession: null, boundaryMessageID: null, creating: false, pending: false,
});
spyOn(sync, 'useUserMessageHistory').mockReturnValue([]);
spyOn(sync, 'useSessions').mockReturnValue([]);
// This fixture deliberately mounts ChatInput without SyncProvider. Keep the
// status branch at its existing idle baseline; provider-backed status behavior
// is covered by the sync and Stop tests.
spyOn(sync, 'useSessionStatus').mockReturnValue(undefined);
const { ChatInput } = await import('@/components/chat/ChatInput');
const { I18nProvider } = await import('@/lib/i18n');
const { nativeDraftFixture, directory } = await import('@/sync/native-draft-fixture');
const { prepareNativeDraft } = await import('@/sync/native-draft-creation');
const { useUIStore } = await import('@/stores/useUIStore');
const { useInputStore } = await import('@/sync/input-store');
const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
const { useConfigStore } = await import('@/stores/useConfigStore');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { browserDisplayName } = await import('@/lib/messages/displayName');
const { useInlineCommentDraftStore } = await import('@/stores/useInlineCommentDraftStore');
spyOn(sync, 'useSessionDirectory').mockImplementation(id => useSessionUIStore(s => id ? s.getDirectoryForSession(id) ?? undefined : undefined));
await sleep(0); await bootstrap.restore(); bootstrapFetch.mockRestore();

export async function mountedNativeComposer(persistChatDraft: boolean, existingDom?: ReturnType<typeof nativeComposerDom>, extraContent?: React.ReactNode, body?: (fixture: ReturnType<typeof nativeDraftFixture>) => React.ReactNode, coldStart?: (fixture: ReturnType<typeof nativeDraftFixture>) => void) {
  const dom = existingDom ?? nativeComposerDom(), fixture = nativeDraftFixture();
  const initialUI = useUIStore.getState(), initialInline = useInlineCommentDraftStore.getState();
  errors.length = 0;
  if (body) browserDisplayName.apply('');
  else browserDisplayName.useUnnamedForTab();
  useUIStore.setState({ persistChatDraft, isMobile: false });
  useDirectoryStore.setState({ currentDirectory: directory });
  // Join the same startup owner as the directory subscription before measuring submit IO.
  await useConfigStore.getState().activateDirectory(directory);
  useInputStore.setState({ pendingInputText: null });
  useSessionUIStore.setState(state => ({ newSessionDraft: { ...state.newSessionDraft, initialPrompt: undefined } }));
  if (coldStart) coldStart(fixture);
  else await prepareNativeDraft();
  const root = createRoot(dom.container);
  let epoch = 0;
  // The production sync module owns these shared contexts. Supply the actual
  // fixture stores/loader/SDK without starting a second provider lifecycle.
  // Custom content may still bind its own inner providers for held A/live B.
  const System = globals.__openchamber_sync_context__;
  const Runtime = globals.__openchamber_sync_runtime_context__;
  if (!System || !Runtime) throw new Error('Actual sync context seam missing');
  const render = () => {
    const value: SyncRuntime = { childStores: fixture.children, messageLoader: fixture.loader,
      sdk: opencodeClient.getSdkClient(), runtimeKey: getRuntimeKey(),
      currentDirectory: {
        get: () => useDirectoryStore.getState().currentDirectory,
        subscribe: notify => useDirectoryStore.subscribe((state, previous) => {
          if (state.currentDirectory !== previous.currentDirectory) notify();
        }),
      } };
    root.render(<I18nProvider key={epoch}><System.Provider value={{ ...value, directory: useDirectoryStore.getState().currentDirectory }}>
      <Runtime.Provider value={value}>{body ? body(fixture) : <ChatInput />}{extraContent}</Runtime.Provider>
    </System.Provider></I18nProvider>);
  };
  try { await act(async () => render()); }
  catch (error) {
    await act(async () => root.unmount()); fixture.dispose(); useUIStore.setState(initialUI, true); if (!existingDom) await dom.restore(); throw error;
  }
  const editor = () => {
    const node = dom.container.querySelector<HTMLElement>('.cm-content');
    const view = node && EditorView.findFromDOM(node);
    if (!view) throw new Error('Actual mounted CodeMirror editor missing');
    return view;
  };
  return { ...fixture, dom, editor,
    rerender: render,
    // Same lifetime boundary as App's epoch-keyed SyncProvider; runtime stores/storage/request stay alive.
    remount: () => { epoch++; render(); },
    text: () => editor().state.doc.toString(),
    replace: (text: string) => act(async () => editor().dispatch({ changes: { from: 0, to: editor().state.doc.length, insert: text }, selection: { anchor: text.length } })),
    mention: (path: string) => act(async () => {
      const transfer = new dom.window.DataTransfer();
      transfer.setData('application/x-openchamber-file-path', path);
      // Happy DOM aliases DragEvent to Event, so supply the standard dataTransfer field explicitly.
      const drop = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(drop, 'dataTransfer', { value: transfer });
      editor().dom.parentElement?.dispatchEvent(drop);
    }),
    submit: () => act(async () => {
      const form = dom.container.querySelector('form');
      if (!form) throw new Error('Actual composer form missing');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await sleep(0);
    }),
    dispose: async () => {
      await act(async () => root.unmount()); fixture.dispose(); useUIStore.setState(initialUI, true);
      useInlineCommentDraftStore.setState(initialInline, true); if (!existingDom) await dom.restore();
    },
  };
}
