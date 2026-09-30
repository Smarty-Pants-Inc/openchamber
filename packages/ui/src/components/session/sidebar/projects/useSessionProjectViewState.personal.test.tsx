import { afterAll, beforeEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';
import { useHumanAuth } from '@/lib/human-auth';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { useSessionProjectViewState } from './useSessionProjectViewState';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { createWebAPIs } from '../../../../../../web/src/api';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { resetRuntimeAuthGeneration } from '@/lib/runtime-auth';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';

const win = new Window({ url: 'https://ui.example.test/' });
const values = { window: win, document: win.document, IS_REACT_ACT_ENVIRONMENT: true };
const names = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const previous = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
for (const name of names) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
const fetchSpy = spyOn(globalThis, 'fetch');
const writes: { method: string; url: string; body: string }[] = [];
fetchSpy.mockImplementation(async (input, init) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  if (method !== 'GET') writes.push({ method, url, body: String(init?.body ?? '') });
  if (url.endsWith('/api/config/sidebar-view')) return Response.json({
    owner: { issuer: 'test-issuer', subject: 'person-a' }, projects: {}, groups: {},
  });
  return Response.json({ projects: [] }, { headers: { 'X-OpenChamber-Settings-CAS': '1', ETag: '"fixture"' } });
});
beforeEach(() => {
  writes.length = 0;
  resetRuntimeAuthGeneration();
  useAuthSessionStore.setState({ state: 'ok' });
});
afterAll(async () => {
  fetchSpy.mockRestore();
  registerRuntimeAPIs(null);
  useHumanAuth.setState({ enabled: false });
  configureRuntimeUrlResolver({});
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
  await win.happyDOM.close();
});
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); });

test('human project click never PUTs shared projects and ignores anonymous collapse', async () => {
  registerRuntimeAPIs(createWebAPIs());
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example.test' });
  getDeferredSafeStorage().setItem('oc.sessions.projectCollapse', JSON.stringify(['unclaimed']));
  useHumanAuth.setState({ enabled: true });
  let view: ReturnType<typeof useSessionProjectViewState> | undefined;
  const projects = [{ id: 'p', sidebarCollapsed: true }];
  const Probe = () => { view = useSessionProjectViewState({ isVSCode: false, projects }); return null; };
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Probe />)); await settle();
    await act(async () => view!.actions.toggleProject('p'));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
    expect(writes.filter(write => write.method === 'PUT')).toEqual([]);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.method).toBe('PATCH');
    expect(JSON.parse(writes[0]!.body)).toEqual({ owner: { issuer: 'test-issuer', subject: 'person-a' }, projects: { p: false } });
    expect(view?.state.collapsedProjects).toEqual(new Set());
  } finally { await act(async () => root.unmount()); }
});

test('switching to legacy restores deliberate anonymous collapse, never claiming it in human mode', async () => {
  useHumanAuth.setState({ enabled: true });
  const storage = getDeferredSafeStorage();
  storage.setItem('oc.sessions.projectCollapse', JSON.stringify(['anonymous']));
  storage.setItem('oc.sessions.groupCollapse', JSON.stringify(['anonymous:g']));
  let view: ReturnType<typeof useSessionProjectViewState> | undefined;
  const projects = [{ id: 'anonymous', sidebarCollapsed: false }];
  const Probe = () => { view = useSessionProjectViewState({ isVSCode: true, projects }); return null; };
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Probe />)); await settle();
    expect(view?.state.collapsedProjects).toEqual(new Set()); expect(view?.state.collapsedGroups).toEqual(new Set());
    await act(async () => useHumanAuth.setState({ enabled: false }));
    expect(view?.state.collapsedProjects).toEqual(new Set(['anonymous']));
    expect(view?.state.collapsedGroups).toEqual(new Set(['anonymous:g'])); expect(writes).toEqual([]);
  } finally { await act(async () => root.unmount()); }
});

test('human explicit false survives default refresh; bulk targets only visible IDs and groups are personal', async () => {
  registerRuntimeAPIs(createWebAPIs());
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example.test' });
  useHumanAuth.setState({ enabled: true });
  getDeferredSafeStorage().setItem('oc.sessions.groupCollapse', JSON.stringify(['anonymous:g']));
  let view: ReturnType<typeof useSessionProjectViewState> | undefined;
  let renderCount = 0;
  let projects = [{ id: 'p', sidebarCollapsed: true }, { id: 'q', sidebarCollapsed: false }];
  const Probe = () => { renderCount++; view = useSessionProjectViewState({ isVSCode: false, projects }); return null; };
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Probe />)); await settle();
    expect(view?.state.collapsedProjects).toEqual(new Set(['p']));
    expect(view?.state.collapsedGroups).toEqual(new Set());
    const initialActions = view!.actions;
    const initialState = view!.state;
    const renders = renderCount;
    await act(async () => useSessionUIStore.setState({ currentSessionId: 'unrelated-selection' }));
    expect(renderCount).toBe(renders); expect(view?.state).toBe(initialState); expect(view?.actions).toBe(initialActions);
    await act(async () => view!.actions.toggleProject('p')); await settle();
    projects = [{ id: 'p', sidebarCollapsed: true }, { id: 'q', sidebarCollapsed: true }];
    await act(async () => root.render(<Probe />));
    expect(view?.state.collapsedProjects).toEqual(new Set(['q']));
    expect(view?.actions).toBe(initialActions);
    await act(async () => { view!.actions.toggleGroup('p:g'); view!.actions.toggleGroup('absent:g'); }); await settle();
    expect(view?.state.collapsedGroups).toEqual(new Set(['p:g', 'absent:g']));
    await act(async () => view!.actions.collapseAllProjects()); await settle();
    await act(async () => view!.actions.toggleGroup('p:g')); await settle();
    expect(view?.state.collapsedProjects).toEqual(new Set(['p', 'q']));
    expect(view?.state.collapsedGroups.has('p:g')).toBe(true);
    await act(async () => view!.actions.expandAllProjects()); await settle();
    expect(view?.state.collapsedProjects).toEqual(new Set());
    expect(view?.state.collapsedGroups).toEqual(new Set(['absent:g']));
    expect(JSON.parse(writes.at(-1)!.body)).toEqual({ owner: { issuer: 'test-issuer', subject: 'person-a' }, projects: { p: false, q: false }, groups: { 'p:g': false } });
    projects = [{ id: 'new', sidebarCollapsed: true }];
    await act(async () => root.render(<Probe />));
    expect(view?.state.collapsedProjects).toEqual(new Set(['new']));
    await act(async () => view!.actions.collapseAllProjects()); await settle();
    expect(JSON.parse(writes.at(-1)!.body)).toEqual({ owner: { issuer: 'test-issuer', subject: 'person-a' }, projects: { new: true }, groups: {} });
    expect(writes.every(write => write.method === 'PATCH')).toBe(true);
    expect(getDeferredSafeStorage().getItem('oc.sessions.groupCollapse')).toBe(JSON.stringify(['anonymous:g']));
  } finally { await act(async () => root.unmount()); }
});
