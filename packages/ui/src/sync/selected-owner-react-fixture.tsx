import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { id } from './selected-owner-review-fixture';
import { useSessionUIStore } from './session-ui-store';
import { useSelectedSessionOwner } from './selected-session-owner';

export async function mountProbe(strict = false) {
  const win = new Window({ url: 'https://owner.invalid' });
  const values = { window: win, document: win.document, navigator: win.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const Probe = () => { const dir = useSessionUIStore(state => state.currentSessionDirectory); useSelectedSessionOwner(id, dir ?? undefined, false); return null; };
  const root = createRoot(document.createElement('div'));
  await act(async () => { root.render(strict ? <React.StrictMode><Probe /></React.StrictMode> : <Probe />); });
  return { root, async close() { await act(async () => root.unmount()); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } await win.happyDOM.close(); } };
}

