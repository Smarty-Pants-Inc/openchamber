import { act } from 'react';
import { expect, test } from 'bun:test';
import { fixture, A, B, id, row, requests } from './selected-owner-review-fixture';
import { mountProbe } from './selected-owner-react-fixture';
import { checkSelectedSessionOwner, readSelectedSessionOwner, retainSelectedSessionOwner } from './selected-session-owner';
import { useSessionUIStore } from './session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { setRuntimeBearerToken } from '@/lib/runtime-auth';
import { deferred } from '@/lib/runtime-isolation-fixture';

const ownerReads = () => requests.filter(request => new URL(request.url).pathname.endsWith(`/session/${id}`));

test('StrictMode cleanup retires first leg but healthy self-adoption A to B keeps its own second leg', async () => {
  const probe = await mountProbe(true);
  try {
    for (let i = 0; i < 40 && readSelectedSessionOwner(id, B)?.status !== 'live'; i++)
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    expect(readSelectedSessionOwner(id, B)?.status).toBe('live');
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(B);
    expect(ownerReads().filter(request => !new URL(request.url).searchParams.has('directory'))).toHaveLength(2);
    expect(ownerReads()[0].signal.aborted).toBe(true);
  } finally { await probe.close(); }
});

test('explicit direct lifecycle shares request; only last release cancels and rejects late adoption', async () => {
  const response = deferred<Response>(), started = deferred<void>();
  fixture.detail = () => { started.resolve(); return response.promise.then(response => response.clone()); };
  const releaseOne = retainSelectedSessionOwner(), releaseTwo = retainSelectedSessionOwner();
  const first = checkSelectedSessionOwner(id, A); await started.promise;
  expect(checkSelectedSessionOwner(id, A)).toBe(first);
  expect(ownerReads()).toHaveLength(1);
  releaseOne(); expect(ownerReads()[0].signal.aborted).toBe(false);
  releaseTwo(); expect(ownerReads()[0].signal.aborted).toBe(true);
  response.resolve(Response.json(row(B))); await first;
  expect(useSessionUIStore.getState().currentSessionDirectory).toBe(A);
  expect(readSelectedSessionOwner(id, B)?.status).not.toBe('live');
});

for (const cause of ['selection ABA', 'catalog', 'auth ABA'] as const) test(`${cause} aborts owned pending read immediately`, async () => {
  const response = deferred<Response>(), started = deferred<void>();
  fixture.detail = () => { started.resolve(); return response.promise.then(response => response.clone()); };
  const check = checkSelectedSessionOwner(id, A); await started.promise;
  if (cause === 'selection ABA') { useSessionUIStore.setState({ currentSessionId: 'other' }); useSessionUIStore.setState({ currentSessionId: id }); }
  if (cause === 'catalog') useProjectsStore.setState({ managedRows: [...useProjectsStore.getState().managedRows ?? []] });
  if (cause === 'auth ABA') { setRuntimeBearerToken('replacement-fixture'); setRuntimeBearerToken('fixture-token'); }
  expect(ownerReads()[0].signal.aborted).toBe(true);
  response.resolve(Response.json(row(B))); await check;
  expect(useSessionUIStore.getState().currentSessionDirectory).toBe(A);
  expect(readSelectedSessionOwner(id, B)?.status).not.toBe('live');
});

test('new selected operation retires old transport before replacing it, not ten seconds later', async () => {
  const response = deferred<Response>(), started = deferred<void>();
  fixture.detail = () => { started.resolve(); return response.promise.then(response => response.clone()); };
  const first = checkSelectedSessionOwner(id, A); await started.promise;
  useSessionUIStore.setState({ currentSessionDirectory: B });
  expect(ownerReads()[0].signal.aborted).toBe(true);
  const secondStarted = deferred<void>();
  fixture.detail = () => { secondStarted.resolve(); return response.promise.then(response => response.clone()); };
  const second = checkSelectedSessionOwner(id, B); await secondStarted.promise;
  expect(ownerReads().filter(request => !request.signal.aborted)).toHaveLength(1);
  expect(checkSelectedSessionOwner(id, B)).toBe(second);
  response.resolve(Response.json(row(B))); await Promise.all([first, second]);
  const outcome = useSessionUIStore.getState().selectedManagedOwner;
  console.log('replacement owner=', outcome?.status, 'strict/scoped reads=', ownerReads().length);
  expect(readSelectedSessionOwner(id, B)?.status).toBe('live');
});

test('503 unknown never loops; connection recovery retries the mounted hook once', async () => {
  fixture.detail = async () => new Response(null, { status: 503 });
  const probe = await mountProbe();
  try {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    const failedReads = ownerReads().length;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
    expect(ownerReads()).toHaveLength(failedReads);
    expect(readSelectedSessionOwner(id, A)?.status).toBe('unknown');
    fixture.detail = async () => Response.json(row(B));
    await act(async () => { useConfigStore.setState({ isConnected: false }); });
    await act(async () => { useConfigStore.setState({ isConnected: true }); });
    for (let i = 0; i < 40 && readSelectedSessionOwner(id, B)?.status !== 'live'; i++)
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    expect(readSelectedSessionOwner(id, B)?.status).toBe('live');
    expect(ownerReads()).toHaveLength(failedReads + 2);
  } finally { await probe.close(); }
});
