import { expect, test } from 'bun:test';
import { fixture, A, B, id, row, ordinary, view, requests } from './selected-owner-review-fixture';
import { updateSessionTitle, adoptObservedSessionOwner } from './session-actions';
import { mergeBootstrapSessions } from './reconnect-recovery';
import { useSessionUIStore, routeMessage } from './session-ui-store';
import { deferred } from '@/lib/runtime-isolation-fixture';
import { readHerdrState } from '@/lib/herdrSession';
import { readOpenOrdinaryState } from '@/lib/openOrdinaryState';
import { checkSelectedSessionOwner, readSelectedSessionOwner } from './selected-session-owner';

test('LIVE: actual routeMessage sends only to destination, with accepted view and no new fleet read', async () => {
  await checkSelectedSessionOwner(id, A);
  const readsBefore = requests.filter(request => request.url.includes(`/session/${id}`) && !request.url.includes('/message')).length;
  const ownerFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/prompt_async')) { requests.push(request); return new Response(null, { status: 204 }); }
    return ownerFetch(input, init);
  };
  expect(await routeMessage({ runtimeKey: 'owner-test', sessionId: id, directory: B, content: 'hello', providerID: 'p', modelID: 'm' })).toBe('prompt');
  const posts = requests.filter(request => request.method === 'POST');
  console.log('live actual POST=', posts.map(request => ({ directory: new URL(request.url).searchParams.get('directory'), view: request.headers.get('x-smarty-ordinary-view') })));
  expect(posts).toHaveLength(1); expect(new URL(posts[0].url).searchParams.get('directory')).toBe(B); expect(posts[0].headers.get('x-smarty-ordinary-view')).toBe(view);
  expect(requests.filter(request => request.url.includes(`/session/${id}`) && !request.url.includes('/message')).length).toBe(readsBefore + 1);
});

test('PREFLIGHT: generation superseded during dispatch preparation blocks before SDK POST', async () => {
  await checkSelectedSessionOwner(id, A);
  let calls = 0;
  let raw: unknown;
  try { await routeMessage({ runtimeKey: 'owner-test', sessionId: id, directory: B, content: 'hello', providerID: 'p', modelID: 'm', beforeDispatch: () => {
    if (++calls === 4) fixture.stores.ensureChild(B, { bootstrap: false }).setState({ session: [{ ...row(B), ...{ ordinary: { ...ordinary, generation: 'g2' } } }] });
  } }); } catch (error) { raw = error; }
  console.log('preflight calls=', calls, 'raw=', raw);
  expect(raw).toBeInstanceOf(Error); expect(calls).toBe(4); expect(requests.filter(request => request.method !== 'GET')).toHaveLength(0);
});

test('REFRESH: observed move resists actual older bootstrap merge in source and destination', async () => {
  const oldA = fixture.stores.ensureChild(A, { bootstrap: false }).getState().sessionRevision ?? 0;
  const destination = fixture.stores.ensureChild(B, { bootstrap: false });
  destination.setState({ session: [row(B, true)] });
  const oldB = destination.getState().sessionRevision ?? 0;
  adoptObservedSessionOwner(row(B), A);
  const source = fixture.stores.ensureChild(A, { bootstrap: false }).getState(), target = destination.getState();
  const refreshedSource = mergeBootstrapSessions([row(A, true)], [], source.session, { baselineRevision: oldA, eventRevision: source.sessionEventRevision, deletedRevision: source.sessionDeletedRevision });
  const refreshedTarget = mergeBootstrapSessions([row(B, true)], [], target.session, { baselineRevision: oldB, eventRevision: target.sessionEventRevision, deletedRevision: target.sessionDeletedRevision });
  expect(refreshedSource.sessions).toHaveLength(0);
  expect(refreshedTarget.sessions).toHaveLength(1); expect(readHerdrState(refreshedTarget.sessions[0])).toBe('idle');
});

test('MUTATION: checking owner must not send title PATCH to selected fallback instead of child owner', async () => {
  fixture.stores.ensureChild(A, { bootstrap: false }).setState({ session: [row(B, true)] });
  const response = deferred<Response>(); fixture.detail = () => response.promise;
  const check = checkSelectedSessionOwner(id, A);
  const ownerFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => { const request = new Request(input, init); if (request.method === 'PATCH') { requests.push(request); return Response.json(row(B)); } return ownerFetch(input, init); };
  await updateSessionTitle(id, 'new title');
  response.resolve(new Response(null, { status: 503 })); await check;
  const patch = requests.find(request => request.method === 'PATCH');
  console.log('checking title PATCH directory=', patch && new URL(patch.url).searchParams.get('directory'));
  expect(patch).toBeDefined(); expect(new URL(patch!.url).searchParams.get('directory')).toBe(B);
});

test('READONLY: exact fixture.loader read-only marker disables recovered selected source', async () => {
  fixture.history = async () => Response.json([], { headers: { 'x-smarty-read-only': '1' } });
  await checkSelectedSessionOwner(id, A);
  expect(fixture.loader.getSnapshot({ sessionID: id, directory: B }).readOnly).toBe(true);
  expect(readSelectedSessionOwner(id, B)?.status).toBe('unknown'); expect(readOpenOrdinaryState(id, B, false)?.model).toBeNull();
});

test('ROUTING: checking proof must not override confirmed child record ownership', async () => {
  fixture.stores.ensureChild(A, { bootstrap: false }).setState({ session: [row(B, true)] });
  const response = deferred<Response>(); fixture.detail = () => response.promise;
  const check = checkSelectedSessionOwner(id, A);
  const chosen = useSessionUIStore.getState().getDirectoryForSession(id);
  response.resolve(new Response(null, { status: 503 })); await check;
  console.log('checking owner routed=', chosen, 'unknown routed=', useSessionUIStore.getState().getDirectoryForSession(id));
  expect(chosen).toBe(B);
  expect(useSessionUIStore.getState().getDirectoryForSession(id)).toBe(B);
});

test('DISPATCH: checking and unknown actual routeMessage send zero mutations', async () => {
  fixture.detail = async () => new Response(null, { status: 503 });
  let error: unknown;
  try { await routeMessage({ runtimeKey: 'owner-test', sessionId: id, directory: A, content: 'hello', providerID: 'p', modelID: 'm' }); } catch (caught) { error = caught; }
  console.log('checking route raw error=', error);
  expect(error).toBeInstanceOf(Error); expect(requests.filter(request => request.method !== 'GET')).toHaveLength(0);
  await checkSelectedSessionOwner(id, A); error = undefined;
  try { await routeMessage({ runtimeKey: 'owner-test', sessionId: id, directory: A, content: 'hello', providerID: 'p', modelID: 'm' }); } catch (caught) { error = caught; }
  console.log('unknown route raw error=', error);
  expect(error).toBeInstanceOf(Error); expect(requests.filter(request => request.method !== 'GET')).toHaveLength(0);
});

test('GENERATION: a generation change after live proof blocks actual routeMessage', async () => {
  await checkSelectedSessionOwner(id, A);
  fixture.stores.ensureChild(B, { bootstrap: false }).setState({ session: [{ ...row(B), ...{ ordinary: { ...ordinary, generation: 'g2' } } }] });
  await expect(routeMessage({ runtimeKey: 'owner-test', sessionId: id, directory: B, content: 'hello', providerID: 'p', modelID: 'm' })).rejects.toThrow();
  expect(requests.filter(request => request.method !== 'GET')).toHaveLength(0);
});
