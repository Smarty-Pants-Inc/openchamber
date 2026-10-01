import { afterAll, beforeEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { createSession } from '@/sync/session-actions';
import { opencodeClient } from '@/lib/opencode/client';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useHumanAuth } from '@/lib/human-auth';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import { setPersonalSidebarView } from '@/lib/sidebar-view';
import { findSessionRevealTarget, useSessionReveal, useRevealSessionPagination } from './sessionReveal';
import type { SessionGroup, SessionNode } from '../types';

const win = new Window({ url: 'https://ui.example.test/' });
const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const previous = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
const globals = { window: win, document: win.document, IS_REACT_ACT_ENVIRONMENT: true };
for (const key of keys) Object.defineProperty(globalThis, key, { value: globals[key], configurable: true });
const fetch = spyOn(globalThis, 'fetch');
let owner = 'A';
const writes: { owner: { subject: string }; projects?: Record<string, boolean>; groups?: Record<string, boolean> }[] = [];
const node = (id: string): SessionNode => ({ session: { id, directory: '/reveal', title: id, projectID: 'p', version: '1', slug: id, time: { created: 1, updated: 1 } }, children: [], worktree: null });
const group = (nodes: SessionNode[]): SessionGroup => ({ id: 'worktree:actual', label: 'G', branch: null, description: null, isMain: false, worktree: null, directory: '/reveal', sessions: nodes });
let sections: { project: { id: string }; groups: SessionGroup[] }[];
let nodes: SessionNode[];
let limit = 0;
const revealed: string[] = [];
const resolve = (id: string) => findSessionRevealTarget(sections, id);
const onReveal = (target: { groupKey: string }) => { revealed.push(target.groupKey); };
function Probe() {
  useSessionReveal(resolve, onReveal);
  useRevealSessionPagination('p:worktree:actual', nodes, count => { limit = count; });
  return null;
}
const settle = () => act(async () => { await sleep(0); await sleep(0); });
async function mounted(run: (render: () => Promise<void>) => Promise<void>) {
  const root = createRoot(document.createElement('div'));
  const render = async () => { await act(async () => root.render(<Probe />)); await settle(); };
  try { await render(); await run(render); } finally { await act(async () => root.unmount()); }
}
beforeEach(() => {
  owner = 'A'; writes.length = 0; revealed.length = 0; sections = []; nodes = [];
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example.test' });
  useAuthSessionStore.getState().markAuthenticated(); useHumanAuth.setState({ enabled: true });
  useProjectsStore.setState({ projects: [{ id: 'p', path: '/reveal' }], managedCatalogAdmitted: false, managedSessionHold: null });
  useSessionUIStore.getState().setCurrentSession(null);
  fetch.mockImplementation(async (_input, init) => {
    if (init?.method === 'PATCH') { writes.push(JSON.parse(String(init.body))); return Response.json({}); }
    return Response.json({ owner: { issuer: 'test', subject: owner }, projects: { p: true }, groups: { 'p:worktree:actual': true } });
  });
});
afterAll(async () => {
  fetch.mockRestore(); useHumanAuth.setState({ enabled: false }); configureRuntimeUrlResolver({});
  for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  await win.happyDOM.close();
});
const open = (id = 'selected') => act(async () => useSessionUIStore.getState().setCurrentSession(id, '/reveal'));
const materialize = () => { nodes = Array.from({ length: 9 }, (_, i) => node(`other${i}`)).concat(node('selected')); sections = [{ project: { id: 'p' }, groups: [group(nodes)] }]; };

test('delayed row/group reveal consumes once before its setter and exposes the actual root page', async () => {
  await mounted(async render => {
    await open(); expect(writes).toHaveLength(0);
    materialize(); await render();
    expect(writes).toHaveLength(1); expect(writes[0]).toEqual({ owner: { issuer: 'test', subject: 'A' }, projects: { p: false }, groups: { 'p:worktree:actual': false } });
    expect(limit).toBe(10); expect(useSessionUIStore.getState().sessionRevealIntent).toBeNull();
    await render(); expect(writes).toHaveLength(1);
    await act(async () => { await setPersonalSidebarView({ projects: { p: true } }); }); await render();
    expect(writes).toHaveLength(2);
    await open(); await settle(); expect(writes).toHaveLength(3);
  });
});
for (const related of [true, false]) test(`pending manual collapse ${related ? 'same target cancels' : 'unrelated target preserves'}`, async () => {
  await mounted(async render => {
    await open();
    await act(async () => { await setPersonalSidebarView({ groups: { [related ? 'p:worktree:actual' : 'q:other']: true } }); });
    materialize(); await render();
    expect(revealed).toEqual(related ? [] : ['p:worktree:actual']);
    expect(writes).toHaveLength(related ? 1 : 2);
    expect(useSessionUIStore.getState().sessionRevealIntent).toBeNull();
  });
});
test('restore and background materialization never reveal; newer local open wins', async () => {
  await mounted(async render => {
    materialize(); await act(async () => useSessionUIStore.getState().setCurrentSession('selected', '/reveal', 'restore')); await render();
    expect(writes).toHaveLength(0);
    sections = []; await open(); await open('different'); materialize(); await render();
    expect(writes).toHaveLength(0);
    sections[0].groups[0] = group([node('different')]); await render(); expect(writes).toHaveLength(1);
  });
});
test('manual target collapse while create is held survives selection before row upsert', async () => {
  await mounted(async render => {
    let finish!: (value: SessionNode['session']) => void;
    const create = spyOn(opencodeClient, 'createSession').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    try {
      let pending!: ReturnType<typeof createSession>;
      await act(async () => { pending = createSession('new', '/reveal'); });
      await act(async () => { await setPersonalSidebarView({ projects: { p: true } }); });
      await act(async () => { finish(node('selected').session); await pending; });
      materialize(); await render();
      expect(revealed).toEqual([]); expect(writes).toHaveLength(1);
      expect(useSessionUIStore.getState().sessionRevealIntent).toBeNull();
    } finally { create.mockRestore(); }
  });
});

test('child rows never grant root reveal or pagination authority (#1066)', async () => {
  await mounted(async render => {
    const parent = node('parent'); parent.children = [node('selected')];
    nodes = [parent]; sections = [{ project: { id: 'p' }, groups: [group(nodes)] }];
    await open(); await render();
    expect(writes).toHaveLength(0); expect(revealed).toEqual([]);
    expect(findSessionRevealTarget(sections, 'selected')).toBeNull();
  });
});

test('pending A intent is retired across A/B/A immutable request scopes', async () => {
  await mounted(async render => {
    await open(); const old = useSessionUIStore.getState().sessionRevealIntent;
    await act(async () => { useAuthSessionStore.getState().markReauthenticating(); owner = 'B'; useAuthSessionStore.getState().markAuthenticated(); });
    materialize(); await render(); expect(writes).toHaveLength(0);
    expect(useSessionUIStore.getState().sessionRevealIntent).toBeNull();
    await open(); await settle(); expect(writes[0]?.owner.subject).toBe('B');
    await act(async () => { owner = 'A'; useAuthSessionStore.getState().markAuthenticated(); }); await render();
    expect(writes).toHaveLength(1); expect(old?.scope).not.toBe(useSessionUIStore.getState().sessionRevealIntent?.scope);
  });
});
