import { act } from 'react';
import { mountProbe } from './selected-owner-react-fixture';
import { expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { fixture, A, B, id, row, requests } from './selected-owner-review-fixture';
import { useSessionUIStore } from './session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { setRuntimeBearerToken } from '@/lib/runtime-auth';
import { deferred } from '@/lib/runtime-isolation-fixture';
import { readOpenOrdinaryState } from '@/lib/openOrdinaryState';
import { checkSelectedSessionOwner, readSelectedSessionOwner } from './selected-session-owner';


test('FENCE: unmount invalidates pending owner operation before any adoption', async () => {
  const response = deferred<Response>();
  fixture.detail = async request => new URL(request.url).searchParams.has('directory') ? Response.json(row(B)) : response.promise;
  const probe = await mountProbe();
  const check = checkSelectedSessionOwner(id, A);
  await probe.close();
  const strict = requests.find(request => request.url.includes(`/session/${id}`));
  console.log('unmount request aborted=', strict?.signal.aborted);
  expect(strict?.signal.aborted).toBe(true);
  response.resolve(Response.json(row(B))); await check;
  console.log('after unmount directory=', useSessionUIStore.getState().currentSessionDirectory, 'owner=', readSelectedSessionOwner(id, B)?.status);
  expect(useSessionUIStore.getState().currentSessionDirectory).toBe(A);
  expect(readSelectedSessionOwner(id, B)?.status).not.toBe('live');
});

test('STOCK: same selected ID becomes healthy stock after unknown', async () => {
  fixture.detail = async () => new Response(null, { status: 503 });
  await checkSelectedSessionOwner(id, A);
  const stock: Session = { id, directory: A, slug: id, projectID: A, title: 'stock', version: '1', time: { created: 1, updated: 1 } };
  fixture.stores.ensureChild(A, { bootstrap: false }).setState({ session: [stock] });
  useGlobalSessionsStore.getState().upsertSession(stock);
  console.log('stock read=', readSelectedSessionOwner(id, A), 'ordinary=', readOpenOrdinaryState(id, A, false));
  expect(readSelectedSessionOwner(id, A)).toBeNull();
  expect(readOpenOrdinaryState(id, A, false)).toBeUndefined();
});

test('WITHDRAWAL: dropping managed admission falls back to ordinary source path', async () => {
  fixture.detail = async () => new Response(null, { status: 503 }); await checkSelectedSessionOwner(id, A);
  useProjectsStore.setState({ managedCatalogAdmitted: false });
  expect(readSelectedSessionOwner(id, A)).toBeNull();
});

test('RETRY: mounted unknown owner retries after auth generation changes', async () => {
  fixture.detail = async () => new Response(null, { status: 503 });
  const probe = await mountProbe();
  try {
    await act(async () => { await checkSelectedSessionOwner(id, A); });
    expect(readSelectedSessionOwner(id, A)?.status).toBe('unknown');
    const before = requests.length; fixture.detail = async () => Response.json(row(B));
    await act(async () => { setRuntimeBearerToken('reauth-fixture-token'); });
    // Settle the real React effect + SDK + loader. No product delay or manual owner check.
    for (let attempt = 0; attempt < 40 && readSelectedSessionOwner(id, B)?.status !== 'live'; attempt++)
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    const recovered = useSessionUIStore.getState().selectedManagedOwner;
    console.log('after auth owner=', readSelectedSessionOwner(id, A)?.status, 'additional requests=', requests.length - before, 'reason=', recovered?.status === 'unknown' ? recovered.reason : undefined);
    expect(requests.length).toBeGreaterThan(before);
    expect(readSelectedSessionOwner(id, B)?.status).toBe('live');
  } finally { await probe.close(); }
});
