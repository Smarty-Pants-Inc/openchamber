import { afterAll, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';
let vscode = false;
const desktop = await import('@/lib/desktop');
mock.module('@/lib/desktop', () => ({ ...desktop, isVSCodeRuntime: () => vscode }));
const { useProjectSessionSelection } = await import('./useProjectSessionSelection');
import { clearLastActiveSession, persistLastActiveSession } from '@/sync/last-session-cache';
import { getRuntimeKey } from '@/lib/runtime-switch';

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

// smarty-code#113 (R3.19): the person left a new-session draft (an explicit New session clears the last-session pointer)
// and reloaded; the sidebar then selected the active project's latest session (a fleet session, view only) over the
// restored draft. At startup, with no last-session pointer, the draft view owns the screen; a later switch still selects.
const withSession = (id: string, sessionId: string) => ({ project: { id, normalizedPath: `/${id}` },
  groups: [{ id: `${id}-main`, label: id, directory: `/${id}`, sessions: [{ session: { id: sessionId, directory: `/${id}` }, children: [], worktree: null }] }] });
test('at startup without a last-session pointer no session is selected over the draft; with one, or later, it is', async () => {
  // VS Code keeps its stock startup selection (its compact layout opens on the session list, not a restored draft).
  const cases: [pointer: boolean, inVSCode: boolean, expected: string[]][] = [[false, false, []], [true, false, ['code-lead']], [false, true, ['code-lead']]];
  for (const [pointer, inVSCode, expected] of cases) {
    vscode = inVSCode;
    const key = getRuntimeKey();
    clearLastActiveSession(key);
    if (pointer) persistLastActiveSession(key, { sessionId: 'code-lead', directory: '/code' });
    const selected: string[] = [];
    let active = 'code';
    const Probe = () => {
      // SAFETY: the hook reads only these fields of each section and session node.
      useProjectSessionSelection({ projectSections: [withSession('code', 'code-lead'), withSession('dev', 'dev-lead')],
        activeProjectId: active, activeSessionByProject: new Map(), setActiveSessionByProject: () => undefined,
        currentSessionId: null, currentSessionOwnerProjectId: null,
        handleSessionSelect: (id: string) => { selected.push(id); }, newSessionDraftOpen: false, mobileVariant: false,
        openNewSessionDraft: () => undefined, setSessionSwitcherOpen: () => undefined } as never);
      return null;
    };
    // SAFETY: happy-dom's element implements the DOM Element interface React renders into; only its types differ.
    const root = createRoot(win.document.createElement('div') as unknown as Element);
    await act(async () => root.render(<Probe />));
    expect(selected).toEqual(expected);
    active = 'dev';
    await act(async () => root.render(<Probe />));
    expect(selected).toEqual([...expected, 'dev-lead']);
    await act(async () => root.unmount());
    clearLastActiveSession(key);
  }
  vscode = false;
});
