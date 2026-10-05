import { act } from 'react';
import { expect, test } from 'bun:test';
import { fixture, B, id, row, requests } from './selected-owner-review-fixture';
import { mountProbe } from './selected-owner-react-fixture';
import { readSelectedSessionOwner } from './selected-session-owner';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { deferred } from '@/lib/runtime-isolation-fixture';

const owners = () => requests.filter(request => new URL(request.url).pathname.endsWith(`/session/${id}`));
const tick = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
async function settle(matches: () => boolean) {
  for (let turn = 0; turn < 100 && !matches(); turn++) await tick();
  expect(matches()).toBe(true);
}

for (const failure of [false, true]) test(`catalog revalidation and deferred scoped detail reject old title and ${failure ? 'stop on fresh 503' : 'recover with new title'}`, async () => {
  const probe = await mountProbe();
  try {
    await settle(() => readSelectedSessionOwner(id, B)?.status === 'live');
    const originalReads = owners().length;
    const pending = deferred<Response>(), started = deferred<void>();
    let scopedRequest: Request | undefined;
    fixture.detail = async request => {
      if (new URL(request.url).searchParams.has('directory')) {
        scopedRequest = request; started.resolve(); return pending.promise;
      }
      return Response.json(row(B));
    };
    await act(async () => useProjectsStore.setState({ managedRows: [...useProjectsStore.getState().managedRows ?? []] }));
    await settle(() => owners().length === originalReads + 2);
    await started.promise;
    const destination = fixture.stores.ensureChild(B, { bootstrap: false });
    const renamed = { ...destination.getState().session.find(session => session.id === id) ?? row(B), title: 'Newer title' };
    fixture.detail = async () => failure ? new Response(null, { status: 503 }) : Response.json(renamed);
    // The native title action replaces only this row; it is not a new native generation.
    await act(async () => {
      destination.setState({ session: destination.getState().session.map(session => session.id === id ? renamed : session) });
      useGlobalSessionsStore.getState().upsertSession(renamed);
    });
    expect(scopedRequest?.signal.aborted).toBe(true);
    await act(async () => pending.resolve(Response.json(row(B))));
    await settle(() => readSelectedSessionOwner(id, B)?.status === (failure ? 'unknown' : 'live'));
    expect(destination.getState().session.find(session => session.id === id)?.title).toBe('Newer title');
    expect(useGlobalSessionsStore.getState().entityById.get(id)?.title).toBe('Newer title');
    const reads = owners().length;
    expect(reads).toBe(originalReads + (failure ? 3 : 4));
    await tick(); await tick(); await tick();
    expect(owners()).toHaveLength(reads);
    expect(requests.every(request => request.method === 'GET')).toBe(true);
  } finally { await probe.close(); }
});
