import { expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { mergeOrdinaryModel, readOrdinaryModel, sameOrdinaryModel, type OrdinaryModelState } from './ordinaryModel';

const session = (id = 'B', directory = '/workspace/project'): Session => ({
  id, directory, slug: id, projectID: 'project', title: id, version: '1', time: { created: 1, updated: 1 },
});
const state = (sequence = 4, modelID = 'live-b'): OrdinaryModelState => ({
  generation: 'generation-b', sequence,
  model: { providerID: 'provider-b', modelID, name: modelID }, thinkingLevel: 'high',
});
const current = () => ({ ...session(), ordinary: state() });

test('stock sessions do not acquire ordinary ownership', () => {
  const next = session();
  expect(readOrdinaryModel(next)).toBeUndefined();
  expect(mergeOrdinaryModel(session(), next)).toBe(next);
});

test('prepared native send refuses generation/model/effort loss but not a sequence-only update', () => {
  const expected = state();
  expect(sameOrdinaryModel(expected, { ...expected, sequence: 99 })).toBe(true);
  for (const actual of [undefined, { ...expected, generation: 'older-generation' }, state(4, 'other-model'),
    { ...expected, model: { ...expected.model!, providerID: 'other-provider' } },
    { ...expected, thinkingLevel: 'low' as const }, { ...expected, model: null }]) {
    expect(sameOrdinaryModel(expected, actual)).toBe(false);
  }
});

test('ordinary summary ownership fails closed initially but does not erase loaded detail', () => {
  const summary = { ...session(), nativeRuntime: 'ordinary' };
  expect(readOrdinaryModel(summary)?.model).toBeNull();
  expect(readOrdinaryModel(mergeOrdinaryModel(current(), summary))).toEqual(state());
  const other = { ...session('A'), nativeRuntime: 'ordinary' };
  expect(readOrdinaryModel(mergeOrdinaryModel(current(), other))?.model).toBeNull();
});

test('marker-only merges retain ownership without inventing a completed detail response', () => {
  const marker = { ...session(), nativeRuntime: 'ordinary' };
  for (const incoming of [marker, session()]) {
    const merged = mergeOrdinaryModel(marker, incoming);
    expect(Object.hasOwn(merged, 'ordinary')).toBe(false);
    expect(merged).toMatchObject({ nativeRuntime: 'ordinary' });
    expect(readOrdinaryModel(merged)?.model).toBeNull();
  }
});

test('selected native metadata supplies model/provider/effort without catalog or history', () => {
  expect(readOrdinaryModel(current())).toEqual(state());
});

test('same-session lightweight list or rename preserves native ownership and detail', () => {
  const next = { ...session(), title: 'Renamed B', time: { created: 1, updated: 2 } };
  const merged = mergeOrdinaryModel(current(), next);
  expect(merged.title).toBe('Renamed B');
  expect(merged.time.updated).toBe(2);
  expect(readOrdinaryModel(merged)).toEqual(state());
});

for (const next of [session('A'), session('B', '/other-project')]) {
  test(`ownership cannot cross session/directory identity (${next.id}:${next.directory})`, () => {
    expect(mergeOrdinaryModel(current(), next)).toBe(next);
    expect(readOrdinaryModel(next)).toBeUndefined();
  });
}

for (const unavailable of [null, {}, { ...state(0), model: null, thinkingLevel: null }]) {
  test(`explicit unavailable metadata cannot retain a stale usable model (${JSON.stringify(unavailable)})`, () => {
    const next = { ...session(), ordinary: unavailable };
    const merged = mergeOrdinaryModel(current(), next);
    expect(merged).toBe(next);
    expect(readOrdinaryModel(merged)?.model).toBeNull();
  });
}

test('a lower same-generation sequence preserves newer native detail', () => {
  const next = { ...session(), ordinary: state(2, 'old-b') };
  expect(readOrdinaryModel(mergeOrdinaryModel(current(), next))).toEqual(state());
});

test('a newer same-generation model-only revision is accepted', () => {
  const next = { ...session(), ordinary: { ...state(5, 'new-live-b'), thinkingLevel: 'low' } };
  expect(mergeOrdinaryModel(current(), next)).toBe(next);
  expect(readOrdinaryModel(next)?.model?.modelID).toBe('new-live-b');
  expect(readOrdinaryModel(next)?.thinkingLevel).toBe('low');
});
