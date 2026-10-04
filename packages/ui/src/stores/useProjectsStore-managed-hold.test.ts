import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import * as settings from '@/lib/persistence';
import { toast } from '@/components/ui';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { managedSessionHoldExpired, MANAGED_SESSION_HOLD_MS, useProjectsStore } from './useProjectsStore';
import { useDirectoryStore } from './useDirectoryStore';
import { useGlobalSessionsStore } from './useGlobalSessionsStore';
import { getDeferredSafeStorage } from './utils/safeStorage';

const storage = getDeferredSafeStorage();
// The draft's picker hook asks for the runtime APIs; a server render runs no effects, so no-op APIs are enough.
const noopApi = new Proxy({}, { get: () => new Proxy(() => Promise.resolve(undefined), { get: () => () => Promise.resolve(undefined) }) });
mock.module('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => noopApi }));

// smarty-code#608: an opened session whose new project is not in the live catalog yet stays open.
const live = { id: 'live', worktree: '/live/project', name: 'live' };
let run = 0;
const pendingRow = (n: number) => ({ id: `pending-${n}`, worktree: `/live/new-worktree-${n}`, name: 'new worktree' });
let pending: ReturnType<typeof pendingRow>;
const spyNotes = () => spyOn(toast, 'info');
let note: ReturnType<typeof spyNotes>;
let restore: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  // Notes are deduplicated per page load by saved identity, so each test uses a fresh directory.
  pending = pendingRow(++run);
  storage.removeItem('activeProjectId');
  storage.removeItem('lastDirectory');
  useProjectsStore.setState({ projects: [], activeProjectId: null, managedCatalogAdmitted: false,
    managedCatalogStatus: 'stock', managedRows: null, managedProjects: null, managedSessionHold: null });
  // A catalog is already live, and the person has opened a session in the new, not yet admitted worktree.
  useProjectsStore.getState().applyManagedCatalog([live]);
  storage.setItem('lastDirectory', pending.worktree);
  useSessionUIStore.setState({ currentSessionId: 'ses_open', currentSessionDirectory: pending.worktree });
  useDirectoryStore.setState({ currentDirectory: live.worktree });
  const save = spyOn(settings, 'updateDesktopSettings').mockResolvedValue({ ok: true });
  note = spyNotes();
  restore = [save, note];
});
afterEach(() => {
  for (const spy of restore.splice(0)) spy.mockRestore();
  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null });
  storage.removeItem('lastDirectory');
  useProjectsStore.getState().resetManagedCatalog();
});
const liveId = () => useProjectsStore.getState().managedProjects![0]!.id;

test('(a) a publication without the open session\'s project keeps the project, directory and session, with no note', async () => {
  const activeBefore = useProjectsStore.getState().activeProjectId;
  useProjectsStore.getState().applyManagedCatalog([live]);
  await sleep(0);
  expect(useProjectsStore.getState().activeProjectId).toBe(activeBefore);
  expect(useDirectoryStore.getState().currentDirectory).toBe(live.worktree);
  expect(useSessionUIStore.getState().currentSessionId).toBe('ses_open');
  expect(useSessionUIStore.getState().currentSessionDirectory).toBe(pending.worktree);
  expect(note).not.toHaveBeenCalled();
  expect(useProjectsStore.getState().managedSessionHold).toMatchObject({ sessionId: 'ses_open', directory: pending.worktree });
  // The session listing of that publication does not include the held session either; it stays open.
  useGlobalSessionsStore.getState().applyManagedSessions([], useGlobalSessionsStore.getState().mutationRevision, new Set([live.worktree]));
  expect(useSessionUIStore.getState().currentSessionId).toBe('ses_open');
});

test('(b) a later publication that admits the project selects it and keeps the session', async () => {
  useProjectsStore.getState().applyManagedCatalog([live]);
  useProjectsStore.getState().applyManagedCatalog([live, pending]);
  await sleep(0);
  const admitted = useProjectsStore.getState().managedProjects!.find(project => project.path === pending.worktree)!;
  expect(useProjectsStore.getState().activeProjectId).toBe(admitted.id);
  expect(useDirectoryStore.getState().currentDirectory).toBe(pending.worktree);
  expect(useSessionUIStore.getState().currentSessionId).toBe('ses_open');
  expect(useSessionUIStore.getState().currentSessionDirectory).toBe(pending.worktree);
  expect(useProjectsStore.getState().managedSessionHold).toBeNull();
  expect(note).not.toHaveBeenCalled();
});

test('(c) with no open session the stale saved pointer still falls back with its note', async () => {
  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null });
  useProjectsStore.getState().applyManagedCatalog([live]);
  await sleep(0);
  expect(useProjectsStore.getState().activeProjectId).toBe(liveId());
  expect(useProjectsStore.getState().managedSessionHold).toBeNull();
  expect(note.mock.calls.map(call => String(call[0]))).toEqual([`Saved project ${pending.worktree} is not in the live catalog. Showing live.`]);
});

test('(d) after the bounded wait without the project the hold says it has not arrived, and still holds', () => {
  const realNow = Date.now;
  const start = realNow();
  let now = start;
  Date.now = () => now;
  try {
    useProjectsStore.getState().applyManagedCatalog([live]);
    expect(managedSessionHoldExpired(useProjectsStore.getState().managedSessionHold!)).toBe(false);
    now = start + MANAGED_SESSION_HOLD_MS;
    useProjectsStore.getState().applyManagedCatalog([live]);
    expect(managedSessionHoldExpired(useProjectsStore.getState().managedSessionHold!)).toBe(true);
  } finally { Date.now = realNow; }
  const later = useProjectsStore.getState().managedSessionHold!;
  // Measured from the first publication that lacked the project, not the latest one.
  expect(later.since).toBe(start);
  expect(useSessionUIStore.getState().currentSessionId).toBe('ses_open');
});

test('(e) a session restored before the first admission is held through it, then selected when its project arrives', async () => {
  useProjectsStore.getState().resetManagedCatalog(); // A returning instance: no catalog yet, its session restored.
  useSessionUIStore.setState({ currentSessionId: 'ses_open', currentSessionDirectory: pending.worktree });
  useProjectsStore.getState().admitManagedCatalog(); // The first marker.
  expect(useSessionUIStore.getState().currentSessionId).toBe('ses_open');
  useProjectsStore.getState().applyManagedCatalog([live]); // Its project is not in the first rows.
  expect(useSessionUIStore.getState().currentSessionId).toBe('ses_open');
  expect(useProjectsStore.getState().managedSessionHold?.sessionId).toBe('ses_open');
  useProjectsStore.getState().applyManagedCatalog([live, pending]); // It arrives.
  const state = useProjectsStore.getState();
  expect(state.managedProjects!.find(project => project.id === state.activeProjectId)?.path).toBe(pending.worktree);
  expect(useSessionUIStore.getState().currentSessionId).toBe('ses_open');
  expect(state.managedSessionHold).toBeNull();
});

test('(f) opening a session of a project not admitted yet (the real selection action) waits, then opens it on admission', async () => {
  // Another session is open in an admitted project; the person opens a session of the new worktree.
  useSessionUIStore.setState({ currentSessionId: 'ses_live', currentSessionDirectory: live.worktree });
  useSessionUIStore.getState().setCurrentSession('ses_new', pending.worktree);
  const hold = useProjectsStore.getState().managedSessionHold;
  expect(hold).toMatchObject({ sessionId: 'ses_new', pending: true });
  expect(useSessionUIStore.getState().currentSessionId).toBeNull(); // Not selected: nothing is asked of that directory yet.
  useProjectsStore.getState().applyManagedCatalog([live]); // Still missing: it keeps waiting, with no fallback note.
  expect(useProjectsStore.getState().managedSessionHold?.sessionId).toBe('ses_new');
  expect(note).not.toHaveBeenCalled();
  useProjectsStore.getState().applyManagedCatalog([live, pending]); // Admitted: the waiting open opens.
  expect(useSessionUIStore.getState().currentSessionId).toBe('ses_new');
  const state = useProjectsStore.getState();
  expect(state.managedProjects!.find(project => project.id === state.activeProjectId)?.path).toBe(pending.worktree);
  expect(state.managedSessionHold).toBeNull();
});

test('(g) opening a session of an admitted project selects it at once (no hold)', async () => {
  useSessionUIStore.getState().setCurrentSession('ses_live', live.worktree);
  expect(useSessionUIStore.getState().currentSessionId).toBe('ses_live');
  expect(useProjectsStore.getState().managedSessionHold?.pending).toBeFalsy();
});

test('(h) a newer explicit choice supersedes an open still waiting for its project', async () => {
  useSessionUIStore.getState().setCurrentSession('ses_new', pending.worktree); // Waiting.
  useSessionUIStore.getState().setCurrentSession('ses_live', live.worktree); // Then the person opens another session.
  expect(useProjectsStore.getState().managedSessionHold).toBeNull();
  useProjectsStore.getState().applyManagedCatalog([live, pending]); // The first project arrives later: no jump back.
  expect(useSessionUIStore.getState().currentSessionId).toBe('ses_live');
  useSessionUIStore.getState().setCurrentSession('ses_new2', `${pending.worktree}-b`); // Waiting again...
  useSessionUIStore.getState().openNewSessionDraft({ automatic: true }); // ...the page's own auto-draft keeps it...
  expect(useProjectsStore.getState().managedSessionHold?.sessionId).toBe('ses_new2');
  useSessionUIStore.getState().openNewSessionDraft(); // ...the person's New session drops it.
  expect(useProjectsStore.getState().managedSessionHold).toBeNull();
  useSessionUIStore.getState().closeNewSessionDraft();
});

test('(i) the session listing\'s automatic restore does not replace an open still waiting for its project', async () => {
  useSessionUIStore.getState().setCurrentSession('ses_live', live.worktree); // A, admitted: remembered as the last session.
  useSessionUIStore.getState().setCurrentSession('ses_new', pending.worktree); // B, waiting.
  const { restoreManagedSessionSelection } = await import('@/sync/session-ui-store');
  // SAFETY: a listed session with the two fields the restore reads (id, directory).
  restoreManagedSessionSelection([{ id: 'ses_live', directory: live.worktree } as never]); // A listing refresh without B.
  expect(useProjectsStore.getState().managedSessionHold).toMatchObject({ sessionId: 'ses_new', pending: true });
  useProjectsStore.getState().applyManagedCatalog([live, pending]); // B's project arrives: B opens.
  expect(useSessionUIStore.getState().currentSessionId).toBe('ses_new');
});

test('(j) the page\'s own selections (a first Send admitted, a cold-start restore) keep an open waiting for its project', async () => {
  useSessionUIStore.getState().setCurrentSession('ses_new', pending.worktree); // Waiting.
  useSessionUIStore.getState().setCurrentSession('ses_sent', live.worktree, 'submitted-draft'); // An earlier Send lands.
  expect(useProjectsStore.getState().managedSessionHold).toMatchObject({ sessionId: 'ses_new', pending: true });
  useSessionUIStore.getState().setCurrentSession('ses_live', live.worktree, 'restore'); // The mobile cold-start restore.
  expect(useProjectsStore.getState().managedSessionHold).toMatchObject({ sessionId: 'ses_new', pending: true });
  useProjectsStore.getState().applyManagedCatalog([live, pending]); // Its project arrives: the person's latest choice opens.
  expect(useSessionUIStore.getState().currentSessionId).toBe('ses_new');
});

test('(k) the person\'s route navigation (Back to an admitted session) supersedes an open waiting for its project', async () => {
  useSessionUIStore.getState().setCurrentSession('ses_new', pending.worktree); // Waiting.
  const { restoreManagedSessionSelection } = await import('@/sync/session-ui-store');
  const { persistLastActiveSession } = await import('@/sync/last-session-cache');
  const { getRuntimeKey } = await import('@/lib/runtime-switch');
  persistLastActiveSession(getRuntimeKey(), { sessionId: 'ses_live', directory: live.worktree }); // The route names A.
  // SAFETY: a listed session with the two fields the restore reads (id, directory).
  restoreManagedSessionSelection([{ id: 'ses_live', directory: live.worktree } as never], { chosen: true });
  expect(useSessionUIStore.getState().currentSessionId).toBe('ses_live');
  expect(useProjectsStore.getState().managedSessionHold).toBeNull();
  useProjectsStore.getState().applyManagedCatalog([live, pending]); // B arrives later: no jump back.
  expect(useSessionUIStore.getState().currentSessionId).toBe('ses_live');
});

test('(l) a route open still loading its listing does not override an open the person made after it began', async () => {
  const globalSessions = await import('./useGlobalSessionsStore');
  const { openSessionFromRoute } = await import('@/lib/router/openSessionFromRoute');
  let finishListing = () => {};
  const listing = new Promise<void>(resolve => { finishListing = resolve; });
  const held = spyOn(globalSessions, 'ensureGlobalSessionsLoaded').mockImplementation(async () => {
    await listing;
    // SAFETY: the listing snapshot with the one field the route reads for a managed catalog.
    return { activeSessions: [{ id: 'ses_live', directory: live.worktree }], archivedSessions: [] } as never;
  });
  restore.push(held);
  const routed = openSessionFromRoute('ses_live'); // Back to A: its listing is still loading.
  await sleep(5);
  useSessionUIStore.getState().setCurrentSession('ses_new', pending.worktree); // Then the person opens B, waiting.
  finishListing(); await routed;
  expect(useProjectsStore.getState().managedSessionHold).toMatchObject({ sessionId: 'ses_new', pending: true });
  useProjectsStore.getState().applyManagedCatalog([live, pending]);
  expect(useSessionUIStore.getState().currentSessionId).toBe('ses_new');
});

test('(m) a route begun after an open started waiting supersedes it before discovery can open it', async () => {
  useSessionUIStore.getState().setCurrentSession('ses_new', pending.worktree); // B waits.
  const { openSessionFromRoute } = await import('@/lib/router/openSessionFromRoute');
  const routed = openSessionFromRoute('ses_live'); // Then the person routes to A.
  expect(useProjectsStore.getState().managedSessionHold).toBeNull(); // At once, before any await.
  useProjectsStore.getState().applyManagedCatalog([live, pending]); // B's project arrives meanwhile: B does not open.
  expect(useSessionUIStore.getState().currentSessionId).not.toBe('ses_new');
  await routed;
});

// Review 5856372597: ONE rule at the one place every selection goes through. While an open waits for its project, only
// the person's own selection changes the view (and supersedes the waiting open); every selection the page makes is a
// no-op for the view. Every source × waiting / not waiting → the view.
type Source = { name: string; person: boolean; select: () => void | Promise<void> };
const sources: Source[] = [
  { name: 'the person opens a session (sidebar, picker, tab)', person: true,
    select: () => { useSessionUIStore.getState().setCurrentSession('ses_live', live.worktree); } },
  { name: 'the person follows a route (Back, a link)', person: true, select: () => {
    // SAFETY: a listed session with the two fields the restore reads (id, directory).
    void import('@/sync/session-ui-store').then(m => m.restoreManagedSessionSelection([{ id: 'ses_live', directory: live.worktree } as never], { chosen: true }));
  } },
  { name: 'the page restores a remembered session', person: false,
    select: () => { useSessionUIStore.getState().setCurrentSession('ses_live', live.worktree, 'restore'); } },
  { name: 'the page opens an admitted first Send', person: false,
    select: () => { useSessionUIStore.getState().setCurrentSession('ses_live', live.worktree, 'submitted-draft'); } },
  { name: 'the listing restores the last session', person: false, select: () => {
    // SAFETY: a listed session with the two fields the restore reads (id, directory).
    void import('@/sync/session-ui-store').then(m => m.restoreManagedSessionSelection([{ id: 'ses_live', directory: live.worktree } as never]));
  } },
  { name: 'the person switches project', person: true,
    select: () => { useProjectsStore.getState().setActiveProject(liveId()); } },
  { name: 'startup selects a project', person: false,
    select: () => { useProjectsStore.getState().setActiveProject(liveId(), { remember: false }); } },
  { name: 'the person picks a project in the draft', person: true, select: () =>
    // The draft the page shows while an open waits; the person picks a project in its picker.
    (async () => {
      const React = await import('react');
      const { renderToString } = await import('react-dom/server');
      const { I18nProvider } = await import('@/lib/i18n');
      const { useDraftTarget } = await import('@/components/chat/composer/state/useDraftTarget');
      let handlers: ReturnType<typeof useDraftTarget> | undefined;
      const Probe = () => { handlers = useDraftTarget(true); return null; };
      renderToString(React.createElement(I18nProvider, null, React.createElement(Probe)));
      handlers?.handleDraftProjectChange(liveId());
    })() },
  { name: 'the person types in the draft', person: true, select: async () => {
    const store = useSessionUIStore.getState();
    if (!store.newSessionDraft.open) store.openNewSessionDraft({ automatic: true }); // The page's draft while it waits.
    const { markDraftInputEdited } = await import('@/sync/session-ui-store');
    markDraftInputEdited(useSessionUIStore.getState().newSessionDraft.draftId);
  } },
  { name: 'the catalog publishes (a fallback)', person: false,
    select: () => { useProjectsStore.getState().applyManagedCatalog([live]); } },
];
for (const source of sources) {
  for (const waiting of [true, false]) {
    test(`(table) ${source.name}, ${waiting ? 'while an open waits' : 'with nothing waiting'}`, async () => {
      const { persistLastActiveSession } = await import('@/sync/last-session-cache');
      const { getRuntimeKey } = await import('@/lib/runtime-switch');
      useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null });
      persistLastActiveSession(getRuntimeKey(), { sessionId: 'ses_live', directory: live.worktree });
      if (waiting) useSessionUIStore.getState().setCurrentSession('ses_new', pending.worktree);
      await source.select();
      await sleep(5);
      const view = useSessionUIStore.getState().currentSessionId;
      const hold = useProjectsStore.getState().managedSessionHold;
      const projectOnly = /catalog|project|types/.test(source.name); // These select a project (or a draft), not a session.
      if (!waiting) {
        if (projectOnly) expect(view).toBeNull();
        else expect(view).toBe('ses_live');
        return;
      }
      if (source.person) {
        expect(view).toBe(projectOnly ? null : 'ses_live'); // The person's choice shows, and the waiting open is gone.
        expect(hold).toBeNull();
      } else {
        expect(view).toBeNull(); // Nothing else is selected or fetched: the waiting open stays.
        expect(hold).toMatchObject({ sessionId: 'ses_new', pending: true });
      }
    });
  }
}
