import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { fixture, id } from './selected-owner-review-fixture';
import { opencodeClient } from '@/lib/opencode/client';
import { useSessionUIStore } from './session-ui-store';
import { useSelectedSessionOwner } from './selected-session-owner';
import type { useSyncRuntime } from './sync-context';

type Runtime = ReturnType<typeof useSyncRuntime>;
const globals: typeof globalThis & { __openchamber_sync_runtime_context__?: React.Context<Runtime | null> } = globalThis;

export async function mountProbe(strict = false, CustomProbe?: React.ComponentType) {
  const win = new Window({ url: 'https://owner.invalid' });
  const values = { window: win, document: win.document, navigator: win.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const context = globals.__openchamber_sync_runtime_context__;
  if (!context) throw new Error('Native sync runtime context missing');
  const runtime: Runtime = { childStores: fixture.stores, messageLoader: fixture.loader, sdk: opencodeClient.getSdkClient(), runtimeKey: 'owner-test',
    currentDirectory: { get: () => useSessionUIStore.getState().currentSessionDirectory ?? '', subscribe: listener => useSessionUIStore.subscribe(listener) } };
  const Probe = () => { const dir = useSessionUIStore(state => state.currentSessionDirectory); useSelectedSessionOwner(id, dir ?? undefined, false); return null; };
  const root = createRoot(document.createElement('div'));
  const Body = CustomProbe ?? Probe;
  const content = <context.Provider value={runtime}><Body /></context.Provider>;
  await act(async () => { root.render(strict ? <React.StrictMode>{content}</React.StrictMode> : content); });
  return { root, async close() { await act(async () => root.unmount()); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } await win.happyDOM.close(); } };
}
