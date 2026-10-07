import { act } from 'react';
import { afterEach, expect, test } from 'bun:test';
import { fixture, A, B, id, row, requests } from './selected-owner-review-fixture';
import { mountProbe } from './selected-owner-react-fixture';
import * as owner from './selected-session-owner';
import * as operation from './selected-owner-operation';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionUIStore } from './session-ui-store';

// Security P2 #3 / Astra P2 recovery exhaustion: an unknown owner must recover when transport returns, even when the
// connection state never changes, and the delayed fallback must stay bounded.
const owners = () => requests.filter(request => new URL(request.url).pathname.endsWith(`/session/${id}`));
const strict = () => owners().filter(request => !new URL(request.url).searchParams.has('directory'));
const wait = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
async function settle(matches: () => boolean, turns = 200) {
  for (let turn = 0; turn < turns && !matches(); turn++) await wait(5);
  expect(matches()).toBe(true);
}
const status = (directory = A) => owner.readSelectedSessionOwner(id, directory)?.status;
// A transport failure, not a 503: a 503 also asks for a managed listing (#811), which this fixture does not serve.
const unavailable = async (): Promise<Response> => { throw new TypeError('Failed to fetch'); };
const original = [2_000, 5_000, 15_000];
afterEach(() => { owner.selectedOwnerRecovery.delaysMs = original; });

test('an exhausted recheck budget recovers once on a transport-readiness signal while connection stays ready', async () => {
  owner.selectedOwnerRecovery.delaysMs = [20, 20];
  fixture.detail = unavailable;
  const probe = await mountProbe();
  try {
    await settle(() => status() === 'unknown' && strict().length === 3);
    await wait(120);
    expect(strict()).toHaveLength(3); // One check plus two budgeted rechecks, then no polling.
    expect(status()).toBe('unknown');
    fixture.detail = async () => Response.json(row(B));
    await wait(120);
    expect(strict()).toHaveLength(3); // Silent transport recovery alone changes nothing subscribed.
    expect(useConfigStore.getState().isConnected).toBe(true);
    await act(async () => { operation.notifySelectedOwnerTransportReady(); });
    await settle(() => status(B) === 'live');
    expect(strict()).toHaveLength(4);
    expect(requests.every(request => request.method === 'GET')).toBe(true);
  } finally { await probe.close(); }
});

test('a readiness signal refills the budget, so a later silent recovery is still found without polling forever', async () => {
  owner.selectedOwnerRecovery.delaysMs = [20, 20];
  fixture.detail = unavailable;
  const probe = await mountProbe();
  try {
    await settle(() => status() === 'unknown' && strict().length === 3);
    await act(async () => { operation.notifySelectedOwnerTransportReady(); });
    await settle(() => strict().length === 6); // Signal check plus a refilled two-step budget.
    await wait(120);
    expect(strict()).toHaveLength(6);
    expect(status()).toBe('unknown');
  } finally { await probe.close(); }
});

test('the delayed fallback recovers a connected, catalog-ready unknown owner without any signal', async () => {
  owner.selectedOwnerRecovery.delaysMs = [30, 60];
  fixture.detail = unavailable;
  const probe = await mountProbe();
  try {
    await settle(() => status() === 'unknown');
    expect(strict()).toHaveLength(1);
    fixture.detail = async () => Response.json(row(B));
    await settle(() => status(B) === 'live');
    expect(strict()).toHaveLength(2);
    await wait(150);
    expect(strict()).toHaveLength(2);
  } finally { await probe.close(); }
});

test('no delayed recheck runs while disconnected; unmount cancels a pending one', async () => {
  owner.selectedOwnerRecovery.delaysMs = [30, 30];
  fixture.detail = unavailable;
  await act(async () => { useConfigStore.setState({ isConnected: false }); });
  const first = await mountProbe();
  try {
    await settle(() => status() === 'unknown');
    await wait(150);
    expect(strict()).toHaveLength(1);
  } finally { await first.close(); }
  await act(async () => { useConfigStore.setState({ isConnected: true }); });
  useSessionUIStore.setState({ selectedManagedOwner: null });
  const second = await mountProbe();
  await settle(() => status() === 'unknown');
  const reads = strict().length;
  await second.close();
  await wait(150);
  expect(strict()).toHaveLength(reads);
});

test('a readiness signal never starts a check for a live owner or after unmount', async () => {
  const probe = await mountProbe();
  try {
    await settle(() => status(B) === 'live');
    const reads = owners().length;
    await act(async () => { operation.notifySelectedOwnerTransportReady(); });
    await wait(30);
    expect(owners()).toHaveLength(reads);
  } finally { await probe.close(); }
  const reads = owners().length;
  operation.notifySelectedOwnerTransportReady();
  await wait(30);
  expect(owners()).toHaveLength(reads);
});
