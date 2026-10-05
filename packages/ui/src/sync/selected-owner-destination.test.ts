import { expect, test } from 'bun:test';
import { fixture, A, B, id, row, ordinary, requests } from './selected-owner-review-fixture';
import { readOrdinaryModel } from '@/lib/opencode/ordinaryModel';
import { readOpenOrdinaryState } from '@/lib/openOrdinaryState';
import { checkSelectedSessionOwner, readSelectedSessionOwner } from './selected-session-owner';
import { routeMessage } from './session-ui-store';

test('DESTINATION: newer child generation arriving during detail read cannot be overwritten by older detail', async () => {
  const destination = fixture.stores.ensureChild(B, { bootstrap: false });
  destination.setState({ session: [row(B)] });
  fixture.detail = async request => {
    if (new URL(request.url).searchParams.has('directory')) {
      destination.setState({ session: [{ ...row(B), ...{ ordinary: { ...ordinary, generation: 'g2', sequence: 2, model: { providerID: 'p', modelID: 'new', name: 'New' } } } }] });
      console.log('destination before older GET returns=', readOpenOrdinaryState(id, B, false));
    }
    return Response.json(row(B));
  };
  await checkSelectedSessionOwner(id, A);
  const after = destination.getState().session.find(session => session.id === id);
  console.log('destination after adoption=', readOrdinaryModel(after), 'owner=', readSelectedSessionOwner(id, B)?.status, 'send model=', readOpenOrdinaryState(id, B, false)?.model);
  const ownerFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => { const req = new Request(input, init); if (req.method === 'POST' && new URL(req.url).pathname.endsWith('/prompt_async')) { requests.push(req); return new Response(null, { status: 204 }); } return ownerFetch(input, init); };
  // Donor awaited an old-model POST. The repaired contract refuses Unavailable before that POST.
  await expect(routeMessage({ runtimeKey: 'owner-test', sessionId: id, directory: B, content: 'hello', providerID: 'p', modelID: 'new' })).rejects.toThrow('Unavailable');
  const post = requests.find(req => req.method === 'POST');
  console.log('after destination g2 clobber actual POST body=', post && await post.clone().json());
  expect(readOrdinaryModel(after)?.generation).toBe('g2');
  expect(requests.filter(req => req.method === 'POST')).toHaveLength(0);
  expect(readOrdinaryModel(fixture.stores.ensureChild(B, { bootstrap: false }).getState().session.find(row => row.id === id))?.generation).toBe('g2');
  expect(readSelectedSessionOwner(id, B)?.status).not.toBe('live');
});

