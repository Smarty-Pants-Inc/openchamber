import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { useSessionUIStore } from './session-ui-store';
import { createSession } from './session-actions';
import { opencodeClient } from '@/lib/opencode/client';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { setRuntimeExtraHeaders } from '@/lib/runtime-auth';
import { isPersonalSidebarAdmissionCurrent } from '@/lib/sidebar-view';
import { isRuntimeRequestScopeCurrent } from '@/lib/runtime-switch';

const project = { id: 'p', path: '/reveal' };
const row = { id: 'created', directory: project.path, title: 'created', projectID: 'p', version: '1', slug: 'created', time: { created: 1, updated: 1 } };
beforeEach(() => {
  useProjectsStore.setState({ projects: [project], activeProjectId: 'p', managedCatalogAdmitted: false, managedCatalogStatus: 'stock', managedSessionHold: null });
  useSessionUIStore.getState().setCurrentSession(null);
});
afterEach(() => { setRuntimeExtraHeaders({}); });

test('explicit same-ID reopen is a new intent; restore is not', () => {
  const ui = useSessionUIStore.getState();
  ui.setCurrentSession('one', project.path);
  const first = useSessionUIStore.getState().sessionRevealIntent;
  expect(first?.sessionId).toBe('one');
  ui.setCurrentSession('one', project.path);
  expect(useSessionUIStore.getState().sessionRevealIntent?.revision).not.toBe(first?.revision);
  const second = useSessionUIStore.getState().sessionRevealIntent;
  ui.setCurrentSession('one', project.path, 'restore');
  expect(useSessionUIStore.getState().sessionRevealIntent).toBe(second);
});

test('failed create leaves no reveal work', async () => {
  const create = spyOn(opencodeClient, 'createSession').mockRejectedValue(new Error('test refusal'));
  try { expect(await createSession('new', project.path)).toBeNull(); expect(useSessionUIStore.getState().sessionRevealIntent).toBeNull(); }
  finally { create.mockRestore(); }
});

test('create publishes intent before global upsert', async () => {
  const create = spyOn(opencodeClient, 'createSession').mockResolvedValue(row);
  const intents: Array<string | null | undefined> = [];
  const upsert = spyOn(useGlobalSessionsStore.getState(), 'upsertSession').mockImplementation(() => { intents.push(useSessionUIStore.getState().sessionRevealIntent?.sessionId); });
  try { await createSession('new', project.path); expect(intents).toEqual(['created']); }
  finally { create.mockRestore(); upsert.mockRestore(); }
});

for (const scenario of ['person changed', 'new open'] as const) {
  test(`held creation cannot replace reveal after ${scenario}`, async () => {
    let finish!: (value: typeof row) => void;
    const held = new Promise<typeof row>(resolve => { finish = resolve; });
    const create = spyOn(opencodeClient, 'createSession').mockImplementation(() => held);
    try {
      const pending = createSession('new', project.path);
      if (scenario === 'person changed') setRuntimeExtraHeaders({ 'x-test-person': 'B' });
      else useSessionUIStore.getState().setCurrentSession('newer', project.path);
      const newer = useSessionUIStore.getState().sessionRevealIntent;
      finish(row); await pending;
      if (scenario === 'new open') {
        expect(newer?.sessionId).toBe('newer');
        expect(useSessionUIStore.getState().sessionRevealIntent).toBe(newer);
      } else expect(useSessionUIStore.getState().sessionRevealIntent).toBeNull();
    } finally { create.mockRestore(); }
  });
}

test('explicit draft navigation cancels a pending reveal', () => {
  useSessionUIStore.getState().setCurrentSession('one', project.path);
  useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: 'p', directoryOverride: project.path });
  expect(useSessionUIStore.getState().sessionRevealIntent).toBeNull();
});

for (const collapse of ['none', 'project', 'group'] as const) {
  test(`consumed ${collapse} reveal cannot be resurrected by an unchanged delayed ticket`, () => {
    const ui = useSessionUIStore.getState(), ticket = ui.beginSessionReveal();
    if (collapse !== 'none') ui.blockSessionReveal(collapse === 'project' ? { projects: { p: true } } : { groups: { 'p:root': true } });
    ui.publishSessionReveal(ticket, 'one');
    expect(useSessionUIStore.getState().sessionRevealIntent?.sessionId).toBe('one');
    if (collapse === 'project') expect(useSessionUIStore.getState().sessionRevealIntent?.collapsedProjects.has('p')).toBe(true);
    if (collapse === 'group') expect(useSessionUIStore.getState().sessionRevealIntent?.collapsedGroups.has('p:root')).toBe(true);
    expect(ui.consumeSessionReveal(ticket.revision)).toBe(true);
    expect(isRuntimeRequestScopeCurrent(ticket.scope)).toBe(true);
    expect(isPersonalSidebarAdmissionCurrent(ticket.preferenceAdmission)).toBe(true);
    expect(useSessionUIStore.getState().sessionRevealRevision).toBe(ticket.revision);
    ui.publishSessionReveal(ticket, 'one');
    expect(useSessionUIStore.getState().sessionRevealIntent).toBeNull();
  });
}
