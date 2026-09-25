import { afterEach, expect, test } from 'bun:test';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { useSessionUIStore } from './session-ui-store';

// The store's own storage (in memory under bun), where the remembered draft target lives.
const localStorage = getDeferredSafeStorage();

// smarty-code#126 F5 (Paul's walk on 3.17): with code-lead's session open (project smarty-code), New session went to
// smarty-org, the first workspace (fresh profile), or to the last draft's project (long-lived). A plain New session
// goes to the project of the session the person is in; the startup open keeps the remembered target (#113).
const org = { id: 'org', path: '/p/smarty-org' }, code = { id: 'code', path: '/p/smarty-code' };
const initialProjects = useProjectsStore.getState(), initialUI = useSessionUIStore.getState();
afterEach(() => {
  useProjectsStore.setState(initialProjects, true); useSessionUIStore.setState(initialUI, true);
  localStorage.removeItem('oc.chatInput.lastDraftTarget');
});
function managed(remembered?: typeof org) {
  useProjectsStore.setState({ managedCatalogAdmitted: true, managedCatalogStatus: 'ready', managedProjects: [org, code],
    managedRows: [{ id: 'g-org', worktree: org.path }, { id: 'g-code', worktree: code.path }], activeProjectId: 'org' });
  if (remembered) localStorage.setItem('oc.chatInput.lastDraftTarget', JSON.stringify({ projectId: remembered.id, directory: remembered.path, target: 'project' }));
  // code-lead's session is open.
  useSessionUIStore.setState({ currentSessionId: 'code-lead', currentSessionDirectory: code.path });
}
const target = () => { const d = useSessionUIStore.getState().newSessionDraft; return [d.selectedProjectId, d.directoryOverride]; };

test('fresh profile: New session goes to the open session\'s project, not the first workspace', () => {
  managed();
  useSessionUIStore.getState().openNewSessionDraft();
  expect(target()).toEqual(['code', code.path]);
});

test('long-lived profile: the open session\'s project beats the last draft\'s project', () => {
  managed(org);
  useSessionUIStore.getState().openNewSessionDraft();
  expect(target()).toEqual(['code', code.path]);
});

test('the startup open and an explicit project choice are unchanged', () => {
  managed(org);
  useSessionUIStore.getState().openNewSessionDraft({ automatic: true });
  expect(target()).toEqual(['org', org.path]); // the remembered target (#113)
  useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: 'org', directoryOverride: org.path });
  expect(target()).toEqual(['org', org.path]);
});

test('with no session open, the remembered project is used as before', () => {
  managed(code);
  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null });
  useSessionUIStore.getState().openNewSessionDraft();
  expect(target()).toEqual(['code', code.path]);
});
