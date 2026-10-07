import { expect, test } from 'bun:test';
import { fixture, A, B, id, row, ordinary, requests, view } from './selected-owner-review-fixture';
import { checkSelectedSessionOwner, readSelectedSessionOwner } from './selected-session-owner';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { routeMessage, useSessionUIStore } from './session-ui-store';
import { deferred } from '@/lib/runtime-isolation-fixture';
import { readOrdinaryModel } from '@/lib/opencode/ordinaryModel';
import { readOpenOrdinaryState } from '@/lib/openOrdinaryState';

const newer = () => ({ ...row(B), ordinary: { ...ordinary, generation: 'g2', sequence: 2, model: { providerID: 'p', modelID: 'new', name: 'New' } } });
const postProbe = () => {
  const ownerFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'POST') { requests.push(request); return new Response(null, { status: 204 }); }
    return ownerFetch(input, init);
  };
};

for (const leg of ['strict', 'scoped', 'loader'] as const) test(`destination native CAS across ${leg} await preserves g2 and refuses actual old-model dispatch`, async () => {
  const destination = fixture.stores.ensureChild(B, { bootstrap: false });
  destination.setState({ session: [row(B)] });
  const pending = deferred<Response>(), started = deferred<void>();
  fixture.detail = request => {
    const scoped = new URL(request.url).searchParams.has('directory');
    if (leg === 'strict' && !scoped || leg === 'scoped' && scoped) { started.resolve(); return pending.promise; }
    return Promise.resolve(Response.json(row(B)));
  };
  if (leg === 'loader') fixture.history = () => { started.resolve(); return pending.promise; };
  const check = checkSelectedSessionOwner(id, A); await started.promise;
  destination.setState({ session: [newer()] });
  pending.resolve(leg === 'loader' ? Response.json([], { headers: { 'x-smarty-ordinary-view': view } }) : Response.json(row(B)));
  await check;
  expect(readOrdinaryModel(destination.getState().session.find(session => session.id === id))?.generation).toBe('g2');
  expect(readSelectedSessionOwner(id, B)?.status).not.toBe('live');
  postProbe();
  await expect(routeMessage({ runtimeKey: 'owner-test', sessionId: id, directory: B, content: 'hello', providerID: 'p', modelID: 'm' })).rejects.toThrow('Unavailable');
  expect(requests.filter(request => request.method === 'POST')).toHaveLength(0);
});

test('destination same-generation newer revision/model is not overwritten by old detail', async () => {
  const destination = fixture.stores.ensureChild(B, { bootstrap: false });
  destination.setState({ session: [row(B)] });
  fixture.detail = async request => {
    if (new URL(request.url).searchParams.has('directory')) destination.setState({ session: [{ ...row(B), ...{ ordinary: { ...ordinary, sequence: 2, model: { providerID: 'p', modelID: 'new', name: 'New' } } } }], sessionEventRevision: { [id]: 7 } });
    return Response.json(row(B));
  };
  await checkSelectedSessionOwner(id, A);
  expect(readOrdinaryModel(destination.getState().session[0])?.model?.modelID).toBe('new');
  expect(destination.getState().sessionEventRevision?.[id]).toBe(7);
  expect(readSelectedSessionOwner(id, B)?.status).not.toBe('live');
});

for (const flag of ['ordinaryReloading', 'ordinaryCodeMade', 'herdrNoIdentity'] as const) test(`same-ID ${flag} supersedes live proof even with unchanged healthy model`, async () => {
  await checkSelectedSessionOwner(id, A);
  expect(readSelectedSessionOwner(id, B)?.status).toBe('live');
  fixture.stores.ensureChild(B, { bootstrap: false }).setState({ session: [{ ...row(B), ...{ [flag]: true } }] });
  expect(readSelectedSessionOwner(id, B)?.status).not.toBe('live');
  expect(readOpenOrdinaryState(id, B, false)?.model).toBeNull();
  postProbe();
  await expect(routeMessage({ runtimeKey: 'owner-test', sessionId: id, directory: B, content: 'hello', providerID: 'p', modelID: 'm' })).rejects.toThrow('Unavailable');
  expect(requests.filter(request => request.method === 'POST')).toHaveLength(0);
});

test('live owner proof survives healthy alias reconciliation and late losing-child metadata cannot route mutations away', async () => {
  await checkSelectedSessionOwner(id, A);
  expect(readSelectedSessionOwner(id, B)?.status).toBe('live');
  fixture.stores.ensureChild(A, { bootstrap: false }).setState({ session: [row(A, true)] });
  expect(readSelectedSessionOwner(id, B)?.status).toBe('live');
  expect(useSessionUIStore.getState().getDirectoryForSession(id)).toBe(B);
});

test('missing both native observations after unknown is not a same-ID stock replacement or Send recovery', async () => {
  fixture.detail = async () => new Response(null, { status: 404 });
  await checkSelectedSessionOwner(id, A);
  fixture.stores.ensureChild(A, { bootstrap: false }).setState({ session: [] });
  useGlobalSessionsStore.getState().removeSessions([id]);
  expect(readSelectedSessionOwner(id, A)?.status).toBe('checking');
  postProbe();
  await expect(routeMessage({ runtimeKey: 'owner-test', sessionId: id, directory: A, content: 'hello', providerID: 'p', modelID: 'm' })).rejects.toThrow('Unavailable');
  expect(requests.filter(request => request.method === 'POST')).toHaveLength(0);
});
