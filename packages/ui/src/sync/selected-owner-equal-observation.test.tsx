import { act } from 'react';
import { afterEach, expect, test } from 'bun:test';
import { fixture, B, id, row, ordinary, requests } from './selected-owner-review-fixture';
import { mountProbe } from './selected-owner-react-fixture';
import * as owner from './selected-session-owner';
import { useSessionUIStore } from './session-ui-store';
import { readOrdinaryModel } from '@/lib/opencode/ordinaryModel';
import { readOpenOrdinaryState } from '@/lib/openOrdinaryState';
import { deferred } from '@/lib/runtime-isolation-fixture';

// smarty-code#1414 (equal-observation native supersession): a same-ID session.updated that changes only time.updated
// while scoped detail is held advances the native CAS fence but not the owner observation. The obsolete detail must be
// rejected and exactly one bounded replacement check must run, instead of leaving a current unknown that blocks Send.
const owners = () => requests.filter(request => new URL(request.url).pathname.endsWith(`/session/${id}`));
const wait = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
async function settle(matches: () => boolean) {
  for (let turn = 0; turn < 200 && !matches(); turn++) await wait(5);
  expect(matches()).toBe(true);
}
const status = () => owner.readSelectedSessionOwner(id, B)?.status;
const newer = () => ({ ...row(B), ordinary: { ...ordinary, generation: 'g2', sequence: 2, model: { providerID: 'p', modelID: 'new', name: 'New' } } });
const original = [2_000, 5_000, 15_000];
afterEach(() => { owner.selectedOwnerRecovery.delaysMs = original; });

/** Live at B, then a revalidation whose scoped detail is held until the test resolves it. */
async function revalidateWithHeldDetail() {
  owner.selectedOwnerRecovery.delaysMs = [60_000];
  const probe = await mountProbe();
  await settle(() => status() === 'live');
  const held = deferred<Response>(), scoped = deferred<void>();
  let holding = true;
  fixture.detail = async request => {
    if (holding && new URL(request.url).searchParams.has('directory')) { holding = false; scoped.resolve(); return held.promise; }
    return Response.json(fixture.stores.getState(B)?.session.find(session => session.id === id) ?? row(B));
  };
  const before = owners().length;
  const check = owner.checkSelectedSessionOwner(id, B, fixture.stores);
  await scoped.promise;
  const destination = fixture.stores.ensureChild(B, { bootstrap: false });
  const publish = (update: (current: ReturnType<typeof row>) => ReturnType<typeof row>) => {
    const state = destination.getState();
    destination.setState({ session: state.session.map(session => session.id === id ? update(session) : session),
      sessionEventRevision: { ...state.sessionEventRevision, [id]: (state.sessionEventRevision?.[id] ?? 0) + 1 } });
  };
  return { probe, held, check, before, destination, publish };
}

test('time.updated-only same-ID update during held scoped detail gets one replacement check and Send returns', async () => {
  const { probe, held, check, before, publish } = await revalidateWithHeldDetail();
  try {
    await act(async () => { publish(current => ({ ...current, time: { ...current.time, updated: current.time.updated + 1 } })); });
    await act(async () => { held.resolve(Response.json(row(B))); await check; });
    await settle(() => status() === 'live');
    expect(owners()).toHaveLength(before + 4); // Held strict+scoped, then one replacement strict+scoped.
    expect(fixture.loader.getSendableOrdinaryView({ sessionID: id, directory: B }, 'owner-test')).toBeDefined();
    expect(readOpenOrdinaryState(id, B, false)?.model).not.toBeNull();
    await wait(60);
    expect(owners()).toHaveLength(before + 4);
  } finally { await probe.close(); }
});

test('a real native generation change during held detail never grants the obsolete detail', async () => {
  const { probe, held, check, destination, publish } = await revalidateWithHeldDetail();
  try {
    const generations: Array<string | null | undefined> = [];
    const stop = destination.subscribe(() => generations.push(readOrdinaryModel(destination.getState().session.find(session => session.id === id))?.generation));
    await act(async () => { publish(() => newer()); });
    await act(async () => { held.resolve(Response.json(row(B))); await check; });
    await settle(() => status() === 'live');
    stop();
    expect(readOrdinaryModel(destination.getState().session.find(session => session.id === id))?.generation).toBe('g2');
    expect(generations.includes('g1')).toBe(false);
    const proof = useSessionUIStore.getState().selectedManagedOwner;
    expect(proof?.status === 'live' ? readOrdinaryModel(proof.row)?.generation : undefined).toBe('g2');
  } finally { await probe.close(); }
});

test('repeated equal events coalesce into one replacement and a failing transport stops boundedly', async () => {
  const { probe, held, check, before, publish } = await revalidateWithHeldDetail();
  try {
    fixture.detail = async () => { throw new TypeError('Failed to fetch'); };
    await act(async () => {
      for (let step = 0; step < 3; step++) publish(current => ({ ...current, time: { ...current.time, updated: current.time.updated + 1 } }));
    });
    await act(async () => { held.resolve(Response.json(row(B))); await check; });
    await settle(() => status() === 'unknown');
    await wait(80);
    expect(owners()).toHaveLength(before + 3); // Held strict+scoped, one replacement strict that fails, then nothing.
    expect(status()).toBe('unknown');
  } finally { await probe.close(); }
});

test('selection supersession aborts the replacement and starts no other', async () => {
  const { probe, held, check, before, publish } = await revalidateWithHeldDetail();
  try {
    const replacement = deferred<Response>(), started = deferred<void>();
    let replacementRequest: Request | undefined;
    fixture.detail = request => { replacementRequest = request; started.resolve(); return replacement.promise; };
    await act(async () => { publish(current => ({ ...current, time: { ...current.time, updated: current.time.updated + 1 } })); });
    await started.promise;
    expect(owners()).toHaveLength(before + 3);
    await act(async () => { useSessionUIStore.setState({ currentSessionId: 'other-session' }); });
    expect(replacementRequest?.signal.aborted).toBe(true);
    await act(async () => { held.resolve(Response.json(row(B))); replacement.resolve(Response.json(row(B))); await check; });
    await wait(60);
    expect(owners()).toHaveLength(before + 3);
    expect(useSessionUIStore.getState().selectedManagedOwner?.status).not.toBe('live');
  } finally { await probe.close(); }
});
