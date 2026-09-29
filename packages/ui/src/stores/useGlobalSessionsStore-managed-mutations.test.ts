import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { useGlobalSessionsStore } from './useGlobalSessionsStore';
import { useProjectsStore } from './useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { readOrdinaryModel, type OrdinaryModelState } from '@/lib/opencode/ordinaryModel';

const initial = useGlobalSessionsStore.getState(), projects = useProjectsStore.getState(), ui = useSessionUIStore.getState();
const a = '/live-a', b = '/retired-b', c = '/new-c';
const session = (id: string, directory: string, updated = 1): Session => ({
  id, directory, title: `revision-${updated}`, slug: id, projectID: directory, version: '1', time: { created: 1, updated },
});
beforeEach(() => {
  useProjectsStore.setState({ managedCatalogAdmitted: true, managedCatalogStatus: 'ready',
    managedRows: [{ id: 'a', worktree: a }], managedProjects: [{ id: 'a', path: a }] });
  useGlobalSessionsStore.getState().applySnapshot([session('a', a)], []);
});
afterEach(() => {
  useGlobalSessionsStore.setState(initial, true); useProjectsStore.setState(projects, true); useSessionUIStore.setState(ui, true);
});

test('delayed retired-directory events stay out of every public global list while newer live A survives', () => {
  useGlobalSessionsStore.getState().applySessionMutations([
    { type: 'upsert', session: session('b', b, 80) },
    { type: 'upsert', session: session('a', a, 90) },
    { type: 'upsert', session: { ...session('archived-b', b, 100), time: { created: 1, updated: 100, archived: 100 } } },
    { type: 'upsert', session: session('new-a', a, 110) },
  ]);
  const state = useGlobalSessionsStore.getState();
  expect(state.activeSessions.map(s => s.id).sort()).toEqual(['a', 'new-a']);
  expect(state.activeSessions.find(s => s.id === 'a')?.title).toBe('revision-90');
  expect(state.archivedSessions).toEqual([]);
  expect(state.sessionsByDirectory.has(b)).toBe(false);
  expect(state.structure.activeRootIds).not.toContain('b');
  expect(state.structure.activeIdsByDirectory.has(b)).toBe(false);
});

test('a new C event during a held global read is retained for reconciliation but not prematurely published', () => {
  const baseline = useGlobalSessionsStore.getState().mutationRevision;
  useGlobalSessionsStore.getState().upsertSessions([session('c', c, 200), session('b', b, 90), session('a', a, 100)]);
  expect(useGlobalSessionsStore.getState().activeSessions.map(s => s.id)).toEqual(['a']);
  useGlobalSessionsStore.getState().applyManagedSessions([session('a', a), session('c', c)], baseline, new Set([a, c]));
  const state = useGlobalSessionsStore.getState();
  expect(state.activeSessions.find(s => s.id === 'c')?.title).toBe('revision-200');
  expect(state.activeSessions.find(s => s.id === 'a')?.title).toBe('revision-100');
  expect(state.entityById.has('b')).toBe(false);
  expect(state.sessionsByDirectory.has(b)).toBe(false);
});

test('same-view snapshot prunes excluded event cache and cannot preserve retired selection; stock stays permissive', () => {
  useGlobalSessionsStore.getState().upsertSession(session('b', b));
  const state = useGlobalSessionsStore.getState();
  useSessionUIStore.setState({ currentSessionId: 'b', currentSessionDirectory: b });
  state.applyManagedSessions([session('a', a)], state.mutationRevision, new Set([a]));
  expect(useGlobalSessionsStore.getState().entityById.has('b')).toBe(false);
  expect(useSessionUIStore.getState().currentSessionId).toBeNull();
  useProjectsStore.setState({ managedCatalogAdmitted: false });
  useGlobalSessionsStore.getState().upsertSession(session('b', b));
  expect(useGlobalSessionsStore.getState().activeSessions.map(s => s.id)).toContain('b');
});

// smarty-code#600 (Release 3.47, run 1): right after a Pi relaunch, one listing left the open session out while its
// project stayed listed; the page cleared the selection and showed New session. The open session stays open, shown
// unavailable (Send off with its reason, the draft kept), and comes back when it is listed again.
test('an open session missing from one listing of a live project stays open, unavailable, and comes back when listed', () => {
  const open: Session & { ordinary: OrdinaryModelState } = { ...session('open-a', a),
    ordinary: { generation: 'g1', sequence: 1, model: { providerID: 'p', modelID: 'm', name: 'M' }, thinkingLevel: 'high' } };
  const modelOf = (id: string) => readOrdinaryModel(useGlobalSessionsStore.getState().entityById.get(id))?.model;
  useGlobalSessionsStore.getState().applyManagedSessions([session('a', a), open], useGlobalSessionsStore.getState().mutationRevision, new Set([a]));
  useSessionUIStore.setState({ currentSessionId: 'open-a', currentSessionDirectory: a });
  useGlobalSessionsStore.getState().applyManagedSessions([session('a', a)], useGlobalSessionsStore.getState().mutationRevision, new Set([a]));
  expect(useSessionUIStore.getState().currentSessionId).toBe('open-a'); // not dropped for New session
  expect(modelOf('open-a')).toBeNull(); // shown unavailable: Send off, with its reason
  useGlobalSessionsStore.getState().applyManagedSessions([session('a', a), open], useGlobalSessionsStore.getState().mutationRevision, new Set([a]));
  expect(modelOf('open-a')).toEqual({ providerID: 'p', modelID: 'm', name: 'M' });
});
