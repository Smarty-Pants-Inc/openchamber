import { act } from 'react';
import { expect, test } from 'bun:test';
import { fixture, B, id, row, requests } from './selected-owner-review-fixture';
import { mountProbe } from './selected-owner-react-fixture';
import { checkSelectedSessionOwner, readSelectedSessionOwner } from './selected-session-owner';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { MANAGED_CATALOG_HEADER, MANAGED_CATALOG_VERSION, managedProjectView, type ManagedProject } from '@/lib/managed-project-catalog';
import { deferred } from '@/lib/runtime-isolation-fixture';

// smarty-code#1392: a strict 503 asks for a fresh managed listing (#811). Its unchanged rows must not look like a new
// catalog to the selected-owner check, or the check runs again, fails again and asks for another listing.
const owners = () => requests.filter(request => new URL(request.url).pathname.endsWith(`/session/${id}`));
const tick = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
const wait = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
async function settle(matches: () => boolean) {
  for (let turn = 0; turn < 200 && !matches(); turn++) await tick();
  expect(matches()).toBe(true);
}
/** Serves the real catalog refresh (project list plus inclusive session list) with the current managed rows. */
function serveCatalog(rows: () => ManagedProject[]) {
  const base = globalThis.fetch;
  const listings: string[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    if (path === '/api/project') {
      listings.push(path);
      return Response.json(rows().map(project => ({ id: project.id, worktree: project.worktree, time: { created: 0 } })),
        { headers: { [MANAGED_CATALOG_HEADER]: MANAGED_CATALOG_VERSION } });
    }
    if (path === '/api/experimental/session') return Response.json([useGlobalSessionsStore.getState().entityById.get(id) ?? row(B)]);
    if (path.endsWith('/session/status') || path.includes('/fs/') || path.includes('/filesystem')) return Response.json({});
    return base(input, init);
  };
  return listings;
}

/** Live at B under a catalog the real refresh path has already published once (as boot discovery does). */
async function publishedCatalog() {
  await settle(() => readSelectedSessionOwner(id, B)?.status === 'live');
  const rows = useProjectsStore.getState().managedRows ?? [];
  const listings = serveCatalog(() => rows.map(project => ({ ...project })));
  // The open session's project is the active one, as after a real selection.
  const active = managedProjectView(rows, useProjectsStore.getState().projects).find(project => project.path === B)?.id;
  await act(async () => {
    useProjectsStore.setState({ activeProjectId: active ?? null });
    useProjectsStore.getState().applyManagedCatalog(rows.map(project => ({ ...project })));
  });
  await settle(() => readSelectedSessionOwner(id, B)?.status === 'live');
  return { rows, listings };
}

test('catalog-feedback: an unchanged republication after a strict 503 does not retrigger the owner check', async () => {
  const probe = await mountProbe();
  try {
    const { rows, listings } = await publishedCatalog();
    // Transport is down: the event stream is closed, so neither the connection edge nor the delayed budget applies.
    await act(async () => { useConfigStore.setState({ isConnected: false }); });
    fixture.detail = async () => new Response(null, { status: 503 });
    const before = owners().length;
    await act(async () => { await checkSelectedSessionOwner(id, B, fixture.stores); });
    await settle(() => readSelectedSessionOwner(id, B)?.status === 'unknown');
    await settle(() => listings.length >= 1);
    // The #811 listing gap is 3 s; a feedback loop shows attempts at ~0 ms, 4 ms, 3 s and 6 s.
    await wait(6_500);
    expect(owners()).toHaveLength(before + 1);
    expect(useProjectsStore.getState().managedRows).toBe(rows);
    expect(readSelectedSessionOwner(id, B)?.status).toBe('unknown');
    // A real catalog change still permits exactly one fresh check.
    fixture.detail = async () => Response.json(row(B));
    const changed = [...rows, { id: 'c', worktree: '/admitted/added' }];
    await act(async () => { useProjectsStore.getState().applyManagedCatalog(changed); });
    await settle(() => readSelectedSessionOwner(id, B)?.status === 'live');
    expect(owners()).toHaveLength(before + 3);
    expect(requests.every(request => request.method === 'GET')).toBe(true);
  } finally { await probe.close(); }
}, 20_000);

test('title-feedback: a newer title plus a strict 503 stops after one failed recovery and keeps the title', async () => {
  const probe = await mountProbe();
  try {
    const { rows, listings } = await publishedCatalog();
    await act(async () => { useConfigStore.setState({ isConnected: false }); });
    const pending = deferred<Response>(), started = deferred<void>();
    fixture.detail = async request => {
      if (new URL(request.url).searchParams.has('directory')) { started.resolve(); return pending.promise; }
      return Response.json(row(B));
    };
    const before = owners().length;
    void checkSelectedSessionOwner(id, B, fixture.stores);
    await started.promise;
    const destination = fixture.stores.ensureChild(B, { bootstrap: false });
    const renamed = { ...destination.getState().session.find(session => session.id === id) ?? row(B), title: 'Newer title' };
    fixture.detail = async () => new Response(null, { status: 503 });
    await act(async () => {
      destination.setState({ session: destination.getState().session.map(session => session.id === id ? renamed : session) });
      useGlobalSessionsStore.getState().upsertSession(renamed);
    });
    await act(async () => pending.resolve(Response.json(row(B))));
    await settle(() => readSelectedSessionOwner(id, B)?.status === 'unknown');
    await settle(() => listings.length >= 1);
    await wait(6_500);
    // The held read, the observation's one replacement (503), and nothing driven by unchanged listings.
    expect(owners()).toHaveLength(before + 3);
    expect(useProjectsStore.getState().managedRows).toBe(rows);
    expect(destination.getState().session.find(session => session.id === id)?.title).toBe('Newer title');
    expect(useGlobalSessionsStore.getState().entityById.get(id)?.title).toBe('Newer title');
  } finally { await probe.close(); }
}, 20_000);
