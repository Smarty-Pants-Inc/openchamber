import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { mountedNativeComposer } from './nativeComposer.fixture';
import { directory, session } from '@/sync/native-draft-fixture';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { opencodeClient } from '@/lib/opencode/client';
import { toast } from '@/components/ui/toast';
import { resetGoneSessionNotices } from '@/sync/gone-session-notice';

// smarty-code#775 (folds #761): a session that is no longer available used to vanish into an empty draft without a
// word. The page now says so once, in the gateway's own 404 words (#758), or in the same words when its directory left.
const GATEWAY = 'This session is no longer available: its Pi ended or its worktree was removed. (gateway)';
const DEFAULT = 'This session is no longer available: its Pi ended or its worktree was removed.';
let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
const shown: string[] = [];
let status = 404, reads = 0, armed = false;
const spies: { mockRestore(): void }[] = [];
beforeEach(() => {
  shown.length = 0; reads = 0; status = 404; armed = false; resetGoneSessionNotices();
  spies.push(spyOn(toast, 'warning').mockImplementation(message => { shown.push(String(message)); return 'toast'; }));
  const scoped = opencodeClient.getScopedSdkClient.bind(opencodeClient);
  const get = async () => {
    reads++;
    return status === 200 ? { data: session, response: { status } }
      : { error: { name: 'APIError', data: { message: GATEWAY } }, response: { status } };
  };
  // Only the session read answers as the gateway would; everything else is the fixture's own client.
  spies.push(spyOn(opencodeClient, 'getScopedSdkClient').mockImplementation((dir: string) => {
    const real = scoped(dir);
    return new Proxy(real, { get: (target, key) => key === 'session' ? new Proxy(target.session, {
      get: (s, k) => k === 'get' && armed ? get : Reflect.get(s, k) }) : Reflect.get(target, key) });
  }));
});
afterEach(async () => { await mounted?.dispose(); mounted = undefined; spies.splice(0).forEach(spy => spy.mockRestore()); });
const settle = () => sleep(0);
const rows = [{ id: 'gateway-a', worktree: directory }];

async function reloadWithRemembered(listedDirectory: boolean) {
  const c = mounted = await mountedNativeComposer(true);
  await c.replace('One accepted input'); await c.submit(); await act(settle);
  expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
  armed = true; // From here the gateway answers the session read as gone (or, in one case, still there).
  await act(async () => {
    useProjectsStore.getState().resetManagedCatalog();
    useProjectsStore.setState({ projects: [{ id: 'stale', path: '/stale-project' }], activeProjectId: 'stale' });
    useDirectoryStore.setState({ currentDirectory: '/stale-project' });
    useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, nativeDraftCreations: new Map() });
    useSessionUIStore.getState().openNewSessionDraft({ automatic: true }); // The page's own boot draft.
    c.remount(); await settle();
    useProjectsStore.getState().admitManagedCatalog();
    useProjectsStore.getState().applyManagedCatalog(listedDirectory ? rows : []);
    // The reload's list: the remembered session is not in it.
    useGlobalSessionsStore.getState().applyManagedSessions([], useGlobalSessionsStore.getState().mutationRevision,
      new Set(listedDirectory ? [directory] : []));
    await settle(); await settle();
  });
}

test('reload: a remembered session whose Pi ended is named gone, in the gateway\'s own words, once', async () => {
  await reloadWithRemembered(true);
  expect(useSessionUIStore.getState().currentSessionId).toBeNull();
  expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true); // The draft stays the next step.
  expect(shown).toEqual([GATEWAY]);
  expect(reads).toBe(1);
});

test('reload: a remembered session whose worktree left the catalog is named gone, without a read', async () => {
  await reloadWithRemembered(false);
  expect(shown).toEqual([DEFAULT]);
  expect(reads).toBe(0);
});

test('reload: a session the gateway still answers is not called gone (only a 404 is)', async () => {
  status = 200;
  await reloadWithRemembered(true);
  expect(shown).toEqual([]);
});

test('an open session that leaves the list (its worktree removed while open, #761) is named gone', async () => {
  const c = mounted = await mountedNativeComposer(true);
  await c.replace('One accepted input'); await c.submit(); await act(settle);
  expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
  armed = true; // From here the gateway answers the session read as gone (or, in one case, still there).
  await act(async () => {
    useProjectsStore.getState().applyManagedCatalog([]);
    useGlobalSessionsStore.getState().applyManagedSessions([], useGlobalSessionsStore.getState().mutationRevision, new Set());
    await settle(); await settle();
  });
  // Its project left first, so the open is held for it (#608); the notice still says why it is gone.
  expect(shown).toEqual([DEFAULT]);
});
