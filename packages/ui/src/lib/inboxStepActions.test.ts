import { expect, test } from 'bun:test';
import { changeInboxStep } from './inboxStepActions';
import { STEP_DONE_REPORT } from './inboxSteps';
import { InboxRequestError, type InboxItem } from './smartyInbox';

const open: InboxItem = { id: 'step:a:1', to: 'paul', title: 'Topic — instruction', source: 'steps:v1:a:01/01',
  actions: ['respond'], links: [], priority: 'normal', recommendation: 'echo exact', created: 'v0', updated: 'v1' };
const stamp = { at: 'v2', by: 'paul', action: 'respond' };
const done: InboxItem = { ...open, updated: 'v2', answer: { ...stamp, text: STEP_DONE_REPORT }, resolved: stamp };
const reads: string[] = [], writes: { id: string; action: string; body: object }[] = [];
const dependencies = (writeResult: () => Promise<InboxItem>, readResult = async () => done) => ({
  operationKey: () => 'one-operation',
  write: async (id: string, action: 'answer' | 'resolve' | 'reopen' | 'snooze', body: Record<string, string>) => {
    writes.push({ id, action, body }); return writeResult();
  },
  read: async (id: string) => { reads.push(id); return readResult(); },
});

test('Done and Undo post the displayed version plus operation key, never acceptance', async () => {
  writes.length = reads.length = 0;
  expect(await changeInboxStep(open, false, dependencies(async () => done))).toEqual({ state: 'stored', item: done });
  expect(writes[0]).toEqual({ id: open.id, action: 'answer', body: {
    text: STEP_DONE_REPORT, action: 'respond', updated: 'v1', opKey: 'one-operation',
  } });
  const reopened = { ...open, updated: 'v3' };
  expect(await changeInboxStep(done, true, dependencies(async () => reopened))).toEqual({ state: 'stored', item: reopened });
  expect(writes[1]).toEqual({ id: open.id, action: 'reopen', body: { updated: 'v2', opKey: 'one-operation' } });
  expect(reads).toEqual([]);
});

test('a stale-version refusal does not tick, read or replay the write', async () => {
  writes.length = reads.length = 0;
  const result = await changeInboxStep(open, false, dependencies(async () => { throw new InboxRequestError('Item changed', false); }));
  expect(result).toEqual({ state: 'refused', error: 'Item changed' });
  expect(writes).toHaveLength(1); expect(reads).toEqual([]);
});

test('a lost acknowledgement reads the item once, never replays; failed read remains uncertain', async () => {
  for (const failRead of [false, true]) {
    writes.length = reads.length = 0;
    const result = await changeInboxStep(open, false, dependencies(async () => { throw new Error('lost response'); },
      async () => { if (failRead) throw new Error('offline'); return done; }));
    expect(result).toEqual(failRead ? { state: 'uncertain' } : { state: 'uncertain', item: done });
    expect(writes).toHaveLength(1); expect(reads).toEqual([open.id]);
  }
});

test('an unrelated or non-stored acknowledgement is uncertain and cannot tick a step', async () => {
  for (const receipt of [{ ...done, to: 'other' }, { ...done, id: 'other' }, open]) {
    writes.length = reads.length = 0;
    expect(await changeInboxStep(open, false, dependencies(async () => receipt, async () => open)))
      .toEqual({ state: 'uncertain', item: open });
    expect(writes).toHaveLength(1); expect(reads).toHaveLength(1);
  }
});

test('generic resolved states cannot be marked Done or undone by the Steps action', async () => {
  const resolved = { ...open, resolved: { at: 'v2', by: 'agent', action: 'ignore' } };
  writes.length = reads.length = 0;
  for (const undo of [false, true]) expect((await changeInboxStep(resolved, undo, dependencies(async () => done))).state).toBe('refused');
  expect(writes).toEqual([]); expect(reads).toEqual([]);
});
