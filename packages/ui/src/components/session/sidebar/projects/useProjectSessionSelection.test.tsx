import { afterAll, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';
import { useProjectSessionSelection } from './useProjectSessionSelection';

const win = new Window({ url: 'http://localhost' });
const values = { window: win, document: win.document, navigator: win.navigator, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
afterAll(async () => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
  await win.happyDOM.close();
});

const section = (id: string) => ({ project: { id, normalizedPath: `/${id}` }, groups: [] });
const sections = [section('code'), section('dev')];

// smarty-code#113 (R3.15): on a reload the sidebar saw the startup active project and opened an explicit draft for
// it, recording that project over the remembered (nested worktree) draft target.
test('the startup active project opens no draft; a later switch does', async () => {
  const opened: unknown[] = [];
  let active = 'code';
  const Probe = () => {
    useProjectSessionSelection({ projectSections: sections, activeProjectId: active, activeSessionByProject: new Map(),
      setActiveSessionByProject: () => undefined, currentSessionId: null, currentSessionOwnerProjectId: null,
      handleSessionSelect: () => undefined, newSessionDraftOpen: false, mobileVariant: false,
      openNewSessionDraft: (options?: unknown) => { opened.push(options); }, setSessionSwitcherOpen: () => undefined } as never);
    return null;
  };
  const root = createRoot(win.document.createElement('div') as unknown as Element);
  await act(async () => root.render(<Probe />));
  expect(opened).toEqual([]);
  active = 'dev';
  await act(async () => root.render(<Probe />));
  expect(opened).toEqual([{ selectedProjectId: 'dev', directoryOverride: '/dev' }]);
  await act(async () => root.unmount());
});
