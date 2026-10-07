import { afterAll, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'node:http';
import { z } from 'zod';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { useSessionUIStore } from './session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useHumanAuth } from '@/lib/human-auth';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import { readPersonalSidebarOwner, setPersonalSidebarView } from '@/lib/sidebar-view';
import { captureRuntimeRequestScope } from '@/lib/runtime-switch';
import { findSessionRevealTarget, useSessionReveal, useRevealSessionPagination } from '@/components/session/sidebar/list/sessionReveal';
import type { SessionGroup, SessionNode } from '@/components/session/sidebar/types';

const win = new Window({ url: 'http://ui.example.test/' });
const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const previous = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
const globals = { window: win, document: win.document, IS_REACT_ACT_ENVIRONMENT: true };
for (const key of keys) Object.defineProperty(globalThis, key, { value: globals[key], configurable: true });
const patchSchema = z.object({ owner: z.object({ issuer: z.string(), subject: z.string() }),
  projects: z.record(z.string(), z.boolean()).optional(), groups: z.record(z.string(), z.boolean()).optional() });
let owner = 'A';
const writes: z.infer<typeof patchSchema>[] = [];
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json');
  if (request.method === 'PATCH') {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => { writes.push(patchSchema.parse(JSON.parse(body))); response.end('{}'); });
  } else {
    // A loaded runner answers the preference GET after several event-loop turns (openchamber#542 CI).
    const body = JSON.stringify({ owner: { issuer: 'private-test', subject: owner },
      projects: { p: true }, groups: { 'p:worktree:held': true } });
    setTimeout(() => response.end(body), 25);
  }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${z.object({ port: z.number() }).parse(server.address()).port}`;
const rootProject = { id: 'p', path: '/private/root' };
const heldProject = { id: 'w', path: '/private/held' };
const live = { id: 'root', worktree: rootProject.path };
const arrived = { id: 'held', worktree: heldProject.path, parent: rootProject.path };
const node = (id: string): SessionNode => ({ session: { id, directory: heldProject.path, title: id,
  projectID: 'p', version: '1', slug: id, time: { created: 1, updated: 1 } }, children: [], worktree: null });
const nodes = Array.from({ length: 9 }, (_, i) => node(`other${i}`)).concat(node('selected'));
const group: SessionGroup = { id: 'worktree:held', label: 'Held', branch: null, description: null,
  isMain: false, worktree: null, directory: heldProject.path, sessions: nodes };
let limit = 0;
const revealed: string[] = [];
const onReveal = (target: { groupKey: string }) => { revealed.push(target.groupKey); };
function Probe() {
  const rows = useProjectsStore(state => state.managedRows);
  const sections = rows?.some(row => row.worktree === heldProject.path)
    ? [{ project: rootProject, groups: [group] }] : [];
  useSessionReveal(id => findSessionRevealTarget(sections, id), onReveal);
  useRevealSessionPagination('p:worktree:held', sections.length ? nodes : [], count => { limit = count; });
  return null;
}
const settle = () => act(async () => { await sleep(0); await sleep(0); });
async function mounted(run: () => Promise<void>) {
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Probe />));
    // Reveal waits for the preference GET; join it instead of hoping it lands within settle().
    await act(async () => { await readPersonalSidebarOwner(captureRuntimeRequestScope()); });
    await settle(); await run();
  }
  finally { await act(async () => root.unmount()); }
}
const open = () => act(async () => useSessionUIStore.getState().setCurrentSession('selected', heldProject.path));
const publish = () => act(async () => useProjectsStore.getState().applyManagedCatalog([live, arrived]));
beforeEach(() => {
  writes.length = 0; revealed.length = 0; limit = 0; owner = 'A';
  configureRuntimeUrlResolver({ apiBaseUrl: baseUrl });
  useAuthSessionStore.getState().markAuthenticated(); useHumanAuth.setState({ enabled: true });
  useDirectoryStore.setState({ currentDirectory: '', managedDirectories: null });
  useProjectsStore.setState({ projects: [rootProject, heldProject], activeProjectId: 'p',
    managedCatalogAdmitted: false, managedRows: null, managedProjects: null, managedSessionHold: null, departedDirectories: [] });
  useSessionUIStore.getState().setCurrentSession(null);
  useProjectsStore.getState().applyManagedCatalog([live]);
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  useHumanAuth.setState({ enabled: false }); configureRuntimeUrlResolver({});
  for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  await win.happyDOM.close();
});

for (const collapse of ['project', 'group', 'unrelated', 'none'] as const) {
  test(`actual hold -> catalog admission -> selection preserves ${collapse} collapse intent`, async () => {
    await mounted(async () => {
      await open();
      const original = useSessionUIStore.getState().sessionRevealIntent;
      expect(useSessionUIStore.getState().currentSessionId).toBeNull();
      expect(useProjectsStore.getState().managedSessionHold?.pending).toBe(true);
      expect(writes).toHaveLength(0);
      if (collapse !== 'none') await act(async () => { await setPersonalSidebarView(collapse === 'project'
        ? { projects: { p: true } } : { groups: { [collapse === 'group' ? 'p:worktree:held' : 'q:other']: true } }); });
      // Publish through the actual store, not a delayed group supplied directly to the hook.
      await publish(); await settle();
      expect(useSessionUIStore.getState().currentSessionId).toBe('selected');
      expect(useProjectsStore.getState().managedSessionHold).toBeNull();
      const cancelled = collapse === 'project' || collapse === 'group';
      expect(revealed).toEqual(cancelled ? [] : ['p:worktree:held']);
      expect(limit).toBe(cancelled ? 0 : 10);
      if (cancelled) expect(useSessionUIStore.getState().sessionRevealRevision).toBe(original?.revision);
      expect(writes).toHaveLength((collapse === 'none' ? 0 : 1) + (cancelled ? 0 : 1));
      if (!cancelled) expect(writes.at(-1)).toEqual({ owner: { issuer: 'private-test', subject: 'A' },
        projects: { p: false }, groups: { 'p:worktree:held': false } });
      expect(useSessionUIStore.getState().sessionRevealIntent).toBeNull();
      await publish(); await settle(); expect(revealed).toHaveLength(cancelled ? 0 : 1);
    });
  });
}

test('explicit same-ID reopen after cancelled admission gets a fresh reveal', async () => {
  await mounted(async () => {
    await open();
    await act(async () => { await setPersonalSidebarView({ projects: { p: true } }); });
    await publish(); await settle(); expect(revealed).toEqual([]);
    const revision = useSessionUIStore.getState().sessionRevealRevision;
    await open(); await settle();
    expect(useSessionUIStore.getState().sessionRevealRevision).toBe(revision + 1);
    expect(revealed).toEqual(['p:worktree:held']); expect(limit).toBe(10);
  });
});
for (const explicit of [false, true]) test(`${explicit ? 'explicit same-ID reopen renews' : 'automatic same-ID restore keeps'} held collapse cancellation`, async () => {
  await mounted(async () => {
    await open();
    const revision = useSessionUIStore.getState().sessionRevealRevision;
    await act(async () => { await setPersonalSidebarView({ projects: { p: true } }); });
    await act(async () => useSessionUIStore.getState().setCurrentSession('selected', heldProject.path, explicit ? undefined : 'restore'));
    expect(useSessionUIStore.getState().sessionRevealRevision).toBe(revision + (explicit ? 1 : 0));
    await publish(); await settle();
    expect(revealed).toEqual(explicit ? ['p:worktree:held'] : []);
    expect(writes).toHaveLength(explicit ? 2 : 1);
    expect(useSessionUIStore.getState().currentSessionId).toBe('selected');
  });
});
for (const choice of ['session', 'draft'] as const) test(`newer explicit ${choice} supersedes held open`, async () => {
  await mounted(async () => {
    await open();
    await act(async () => {
      if (choice === 'session') useSessionUIStore.getState().setCurrentSession('newer', rootProject.path);
      else useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: 'p', directoryOverride: rootProject.path });
    });
    await publish(); await settle();
    expect(useSessionUIStore.getState().currentSessionId).not.toBe('selected');
    expect(writes).toHaveLength(0); expect(revealed).toEqual([]);
  });
});
for (const change of ['person', 'runtime'] as const) test(`held ticket cannot reveal after ${change} scope changes`, async () => {
  await mounted(async () => {
    await open();
    await act(async () => {
      if (change === 'person') { owner = 'B'; useAuthSessionStore.getState().markAuthenticated(); }
      else configureRuntimeUrlResolver({ apiBaseUrl: `${baseUrl}/new-runtime` });
    });
    await publish(); await settle();
    expect(writes).toHaveLength(0); expect(revealed).toEqual([]);
    expect(useSessionUIStore.getState().sessionRevealIntent).toBeNull();
  });
});
