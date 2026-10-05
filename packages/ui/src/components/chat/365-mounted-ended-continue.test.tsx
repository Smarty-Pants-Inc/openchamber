import { expect, test } from 'bun:test';
import { act } from 'react';
import { mountedChat, ended, target } from './365-mounted-chat.fixture';
import { pageReply, stateReply } from './365-mounted-http.fixture';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { isSelectedOwnerCurrent } from '@/sync/selected-session-owner';
import { getRuntimeKey } from '@/lib/runtime-switch';

const CONTINUE = 'Continue in a new Pi';
const destination = `${target.directory}/other`;
const staleA = { ...ended, herdrPaneLive: false };

async function checked(directory: string) {
  const f = await mountedChat({ local: staleA, global: staleA });
  try {
    f.controls.session = () => Response.json({ ...staleA, directory, projectID: directory });
    await act(async () => {
      useProjectsStore.setState({ managedCatalogAdmitted: true, managedCatalogStatus: 'ready',
        managedRows: [{ id: 'source', worktree: target.directory }, { id: 'destination', worktree: destination }],
        managedProjects: [{ id: 'project', path: target.directory }, { id: 'other', path: destination }] });
    });
    (await f.page.take()).reply(pageReply(true));
    await f.settle(() => f.loader.getSnapshot(target).status === 'ready');
    await f.settle(() => {
      const proof = useSessionUIStore.getState().selectedManagedOwner;
      return Boolean(proof && isSelectedOwnerCurrent(proof) && (proof.status === 'ended' || proof.status === 'unknown'));
    });
    return f;
  } catch (error) { await f.close(); throw error; }
}

async function clickIfOffered(f: Awaited<ReturnType<typeof mountedChat>>) {
  if (useSessionUIStore.getState().selectedManagedOwner?.status === 'ended') {
    await f.settle(() => f.buttons().includes(CONTINUE));
    await f.click(CONTINUE);
    (await f.post.take()).reply(stateReply('denied'));
    await f.settle(() => f.status()?.status === 'stopped');
  }
}

test('fresh ended B cannot authorize actual Continue/resume POST in selected stale A', async () => {
  const f = await checked(destination);
  try {
    const offered = f.buttons().includes(CONTINUE);
    await clickIfOffered(f); // On unpatched HEAD, capture the actual wrong-directory transport before failing.
    const posts = f.requests.filter(request => request.method === 'POST' && request.url.pathname.endsWith('/resume'));
    console.log('P2 transport', { owner: useSessionUIStore.getState().selectedManagedOwner?.status,
      offered: offered || posts.length > 0, resumeDirectories: posts.map(request => request.url.searchParams.get('directory')) });
    expect(posts).toHaveLength(0);
    expect(f.buttons()).not.toContain(CONTINUE);
    expect(useSessionUIStore.getState().selectedManagedOwner?.status).toBe('unknown');
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(target.directory);
    expect(f.children.getChild(target.directory)?.getState().session[0]).toEqual(staleA);
    expect(useGlobalSessionsStore.getState().entityById.get(target.sessionID)).toEqual(staleA);
    expect(f.loader.getAcceptedOrdinaryView(target, getRuntimeKey())).toBeUndefined();
    expect(f.requests.filter(request => request.url.pathname.endsWith('/session/' + target.sessionID)
      && !request.url.searchParams.has('directory')).length).toBeGreaterThan(0);
  } finally { await f.close(); }
});

test('fresh genuine ended A still renders Continue and sends the actual resume POST to A', async () => {
  const f = await checked(target.directory);
  try {
    await f.settle(() => f.buttons().includes(CONTINUE));
    expect(useSessionUIStore.getState().selectedManagedOwner?.status).toBe('ended');
    expect(f.text()).toContain('This session’s Pi has ended.');
    await clickIfOffered(f);
    const posts = f.requests.filter(request => request.method === 'POST' && request.url.pathname.endsWith('/resume'));
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url.searchParams.get('directory')).toBe(target.directory);
    expect(f.loader.getSnapshot(target).readOnly).toBe(true);
    console.log('SAME transport', { resumeDirectories: posts.map(request => request.url.searchParams.get('directory')) });
  } finally { await f.close(); }
});
