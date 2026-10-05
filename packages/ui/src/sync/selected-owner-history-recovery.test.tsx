import { act } from 'react';
import { expect, test } from 'bun:test';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { opencodeClient } from '@/lib/opencode/client';
import { fixture, B, id, row, requests, view } from './selected-owner-review-fixture';
import { mountProbe } from './selected-owner-react-fixture';
import { readSelectedSessionOwner } from './selected-session-owner';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionUIStore } from './session-ui-store';
import { deferred } from '@/lib/runtime-isolation-fixture';

const target = { sessionID: id, directory: B };
const ownerReads = () => requests.filter(request => new URL(request.url).pathname.endsWith(`/session/${id}`));
const historyReads = () => requests.filter(request => new URL(request.url).pathname.endsWith('/message'));
const page = (readOnly = false) => Response.json([{
  info: { id: 'retained-user', sessionID: id, role: 'user', time: { created: 1 }, agent: 'build', model: { providerID: 'p', modelID: 'm' } },
  parts: [{ id: 'retained-text', messageID: 'retained-user', sessionID: id, type: 'text', text: 'Retained history' }],
}], { headers: readOnly ? { 'x-smarty-read-only': '1' } : { 'x-smarty-ordinary-view': view } });
const tick = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
async function settle(matches: () => boolean) {
  for (let turn = 0; turn < 100 && !matches(); turn++) await tick();
  expect(matches()).toBe(true);
}
async function establish() {
  fixture.history = async () => page();
  const probe = await mountProbe();
  await settle(() => readSelectedSessionOwner(id, B)?.status === 'live');
  expect(fixture.stores.getState(B)?.message[id]).toHaveLength(1);
  return probe;
}

test('established live proof observes exhausted ordinary 503 history failure, stays quiet, and recovers on connection', async () => {
  const probe = await establish();
  try {
    // The native provider supports a raw SDK too. Exercise the real loader's exhausted HTTP retries,
    // without opencodeClient's separate catalog-refresh side effect masking current-proof recovery.
    await act(async () => {
      fixture.loader.configure({ sdk: createOpencodeClient({ baseUrl: 'https://owner.invalid/api', fetch: globalThis.fetch }), runtimeKey: 'owner-test' });
      await fixture.loader.ensure(target, { force: true, reason: 'navigation' });
    });
    const proof = useSessionUIStore.getState().selectedManagedOwner;
    const owners = ownerReads().length, histories = historyReads().length;
    fixture.history = async () => new Response(null, { status: 503 });
    await act(async () => { await fixture.loader.refreshOrdinaryView(target); });
    expect(historyReads()).toHaveLength(histories + 3); // Exhaust the existing loader's three attempts.
    expect(fixture.loader.getSnapshot(target)).toMatchObject({ status: 'error', resolved: false });
    expect(fixture.loader.getSendableOrdinaryView(target, 'owner-test')).toBeUndefined();
    expect(useSessionUIStore.getState().selectedManagedOwner).toBe(proof);
    expect(readSelectedSessionOwner(id, B)?.status).toBe('checking');
    expect(fixture.stores.getState(B)?.message[id]).toHaveLength(1);
    await tick(); await tick();
    expect(ownerReads()).toHaveLength(owners); expect(historyReads()).toHaveLength(histories + 3);
    fixture.history = async () => page();
    await act(async () => fixture.loader.configure({ sdk: opencodeClient.getSdkClient(), runtimeKey: 'owner-test' }));
    await act(async () => useConfigStore.setState({ isConnected: false }));
    await act(async () => useConfigStore.setState({ isConnected: true }));
    await settle(() => readSelectedSessionOwner(id, B)?.status === 'live');
    expect(ownerReads()).toHaveLength(owners + 2); expect(historyReads()).toHaveLength(histories + 4);
    expect(fixture.loader.getSnapshot(target)).toMatchObject({ status: 'ready', resolved: true, readOnly: false });
  } finally { await probe.close(); }
});

test('live to readOnly with retained messages and last branch view gets one automatic fresh selected check', async () => {
  const probe = await establish();
  try {
    const owners = ownerReads().length, histories = historyReads().length;
    const held = deferred<Response>(), scoped = deferred<void>();
    fixture.detail = async request => {
      if (new URL(request.url).searchParams.has('directory')) { scoped.resolve(); return held.promise; }
      return Response.json(row(B));
    };
    fixture.history = async () => page(true);
    await act(async () => { await fixture.loader.refreshOrdinaryView(target); });
    await settle(() => ownerReads().length === owners + 2);
    await scoped.promise;
    expect(fixture.loader.getSnapshot(target)).toMatchObject({ status: 'ready', resolved: true, readOnly: true });
    expect(fixture.loader.getSendableOrdinaryView(target, 'owner-test')).toBe(view);
    expect(readSelectedSessionOwner(id, B)?.status).toBe('checking');
    expect(fixture.stores.getState(B)?.message[id]).toHaveLength(1);
    fixture.history = async () => page();
    await act(async () => held.resolve(Response.json(row(B))));
    await settle(() => readSelectedSessionOwner(id, B)?.status === 'live');
    expect(ownerReads()).toHaveLength(owners + 2); expect(historyReads()).toHaveLength(histories + 2);
  } finally { await probe.close(); }
});

test('readOnly recovery signal followed by strict 503 becomes unknown and never hot-retries', async () => {
  const probe = await establish();
  try {
    const owners = ownerReads().length;
    fixture.detail = async () => new Response(null, { status: 503 });
    fixture.history = async () => page(true);
    await act(async () => { await fixture.loader.refreshOrdinaryView(target); });
    await settle(() => readSelectedSessionOwner(id, B)?.status === 'unknown');
    const histories = historyReads().length;
    await tick(); await tick(); await tick();
    expect(ownerReads()).toHaveLength(owners + 1); expect(historyReads()).toHaveLength(histories);
  } finally { await probe.close(); }
});

test('healthy send revocation retains the last branch view without selected owner revalidation', async () => {
  const probe = await establish();
  try {
    const owners = ownerReads().length;
    await act(async () => { fixture.loader.invalidateOrdinaryView(target); });
    expect(readSelectedSessionOwner(id, B)?.status).toBe('live');
    await tick(); expect(ownerReads()).toHaveLength(owners);
  } finally { await probe.close(); }
});
