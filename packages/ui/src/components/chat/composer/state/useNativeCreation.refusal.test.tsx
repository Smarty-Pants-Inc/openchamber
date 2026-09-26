import React, { act } from 'react';
import { Window } from 'happy-dom';
import { expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { NativeCreationError } from '@/lib/opencode/nativeCreation';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSessionUIStore, type NewSessionDraftState } from '@/sync/session-ui-store';

mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
mock.module('@/sync/native-draft-control', () => ({ refreshNativeCreation: async () => {}, replyNativeCreation: async () => {},
  resumeNativeCreation: async () => {}, abandonNativeCreation: async () => false, abandonedNativeCreations: new Set<string>() }));
const { useNativeCreation } = await import('./useNativeCreation');

// smarty-dev#856: a Send pressed for project A fails late, after she switched the draft to B, whose own Send already
// failed with a reason on screen. A's late refusal is for a target no longer shown: it never replaces B's reason.
test('a late refusal of a switched-away target never replaces the shown target\'s reason', async () => {
  const win = new Window({ url: 'http://localhost' });
  const values = { window: win, document: win.document, navigator: win.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const client = opencodeClient as unknown as Record<string, unknown>;
  const original = { support: client.nativeCreationSupport, list: client.listNativeCreations, draft: useSessionUIStore.getState().newSessionDraft };
  client.nativeCreationSupport = async () => ({ mode: 'interactive', clientRequestId: true, abandon: false });
  client.listNativeCreations = async () => [];
  const target = (project: string) => ({ ...original.draft, open: true, draftId: 7, target: 'project', selectedProjectId: project,
    directoryOverride: `/projects/${project}` }) as NewSessionDraftState;
  useSessionUIStore.setState({ newSessionDraft: target('a') });
  let hook!: ReturnType<typeof useNativeCreation>;
  const Probe = () => { hook = useNativeCreation(useSessionUIStore(state => state.newSessionDraft), null, undefined, getRuntimeKey()); return null; };
  const root = createRoot(win.document.createElement('div') as unknown as Element);
  try {
    await act(async () => root.render(<Probe />));
    const pressedForA = hook; // A's Send keeps the hook it was pressed with.
    await act(async () => useSessionUIStore.setState({ newSessionDraft: target('b') }));
    const reasonB = new NativeCreationError('unavailable', undefined, 'Could not attach broken.docx');
    await act(async () => hook.noteRefusal(reasonB));
    expect(hook.refusal).toBe(reasonB);
    await act(async () => pressedForA.noteRefusal(new NativeCreationError('stale'))); // A fails late.
    expect(hook.refusal).toBe(reasonB); // B's reason stays.
    // Counterexample: a refusal of the shown target itself replaces its line.
    const later = new NativeCreationError('storage');
    await act(async () => hook.noteRefusal(later));
    expect(hook.refusal).toBe(later);
  } finally {
    await act(async () => root.unmount());
    client.nativeCreationSupport = original.support; client.listNativeCreations = original.list;
    useSessionUIStore.setState({ newSessionDraft: original.draft });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    await win.happyDOM.close();
  }
});
