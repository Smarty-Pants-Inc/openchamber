import React, { act } from 'react';
import { Window } from 'happy-dom';
import { expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { NATIVE_CREATION_INVALIDATED, type NativeCreationState } from '@/lib/opencode/nativeCreation';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSessionUIStore, type NewSessionDraftState } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';

mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
mock.module('@/sync/native-draft-control', () => ({ refreshNativeCreation: async () => {}, replyNativeCreation: async () => {},
  resumeNativeCreation: async () => {}, abandonNativeCreation: async () => false, abandonedNativeCreations: new Set<string>() }));
const { useNativeCreation } = await import('./useNativeCreation');

// smarty-code#523: while a start's Pi is frozen, each read of the project's starts takes ~12 s and every
// native.creation.updated event starts a newer one. A finished read is kept unless a newer one was applied, so the
// stuck start (and its Stop) shows; an older read finishing after a newer applied one never overwrites it.
test('a finished read of the starts is kept under steady invalidations, never overwritten by an older one', async () => {
  const win = new Window({ url: 'http://localhost' });
  const values = { window: win, document: win.document, navigator: win.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const client = opencodeClient as unknown as Record<string, unknown>;
  const original = { support: client.nativeCreationSupport, list: client.listNativeCreations, draft: useSessionUIStore.getState().newSessionDraft,
    catalog: useProjectsStore.getState().managedCatalogStatus };
  useProjectsStore.setState({ managedCatalogStatus: 'stock' }); // Discovery answered: checks run.
  const directory = '/projects/a';
  const reads: Array<(operations: NativeCreationState[]) => void> = [], fails: Array<(error: Error) => void> = [];
  client.nativeCreationSupport = async () => ({ mode: 'interactive', clientRequestId: true, abandon: false });
  client.listNativeCreations = () => new Promise<NativeCreationState[]>((resolve, reject) => { reads.push(resolve); fails.push(reject); });
  const stuck = (operationId: string): NativeCreationState => ({ operationId, directory, generation: null, revision: 0,
    phase: 'starting', expiresAt: 0, canInitialReady: false });
  useSessionUIStore.setState({ newSessionDraft: { ...original.draft, open: true, draftId: 9, target: 'project', selectedProjectId: 'a',
    directoryOverride: directory } as NewSessionDraftState });
  let hook!: ReturnType<typeof useNativeCreation>;
  const Probe = () => { hook = useNativeCreation(useSessionUIStore(state => state.newSessionDraft), null, undefined, getRuntimeKey()); return null; };
  const invalidate = () => act(async () => { window.dispatchEvent(new CustomEvent(NATIVE_CREATION_INVALIDATED,
    { detail: { runtimeKey: getRuntimeKey(), directory } })); });
  const root = createRoot(win.document.createElement('div') as unknown as Element);
  try {
    await act(async () => root.render(<Probe />));
    await invalidate(); await invalidate(); // Reads 1..3 in flight.
    expect(reads.length).toBe(3);
    await act(async () => reads[0]([stuck('first')])); // The oldest finishes while newer ones run.
    expect(hook.operations.map(operation => operation.operationId)).toEqual(['first']); // Stop can be offered.
    await act(async () => reads[2]([stuck('third')])); // A newer result replaces it.
    expect(hook.operations.map(operation => operation.operationId)).toEqual(['third']);
    await act(async () => reads[1]([stuck('second')])); // Counterexample: an older read finishing late is dropped.
    expect(hook.operations.map(operation => operation.operationId)).toEqual(['third']);
    // Nor does an older read that fails late: the newer applied result stays, the project is not called unreachable.
    await invalidate(); await invalidate(); // Reads 4 and 5.
    await act(async () => reads[4]([stuck('fifth')]));
    await act(async () => fails[3](new Error('transport timeout')));
    expect(hook.mode).toBe('ordinary');
    expect(hook.operations.map(operation => operation.operationId)).toEqual(['fifth']);
  } finally {
    await act(async () => root.unmount());
    client.nativeCreationSupport = original.support; client.listNativeCreations = original.list;
    useSessionUIStore.setState({ newSessionDraft: original.draft });
    useProjectsStore.setState({ managedCatalogStatus: original.catalog });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    await win.happyDOM.close();
  }
});
