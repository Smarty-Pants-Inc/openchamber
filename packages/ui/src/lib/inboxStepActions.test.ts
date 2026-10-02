import { expect, test } from 'bun:test';
import { actOnInboxStep, changeInboxStep } from './inboxStepActions';
import { STEP_DONE_REPORT } from './inboxSteps';
import { actOnInboxItem, InboxRequestError, type InboxItem } from './smartyInbox';

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

test('operation-key preparation failure is refused before dispatch, without a reconciliation read', async () => {
  writes.length = reads.length = 0;
  const deps = { ...dependencies(async () => done), operationKey: () => { throw new Error('unavailable'); } };
  expect(await changeInboxStep(open, false, deps)).toEqual({ state: 'refused' });
  expect(writes).toEqual([]); expect(reads).toEqual([]);
});

test('runtime missing or throwing UUID support refuses without any write or item read', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const fetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ item: done }); };
  try {
    for (const crypto of [undefined, {}, { randomUUID: () => { throw new Error('unavailable'); } }]) {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: crypto });
      expect(await changeInboxStep(open, false)).toEqual({ state: 'refused' });
    }
    expect(calls).toBe(0);
  } finally {
    globalThis.fetch = fetch;
    if (original) Object.defineProperty(globalThis, 'crypto', original); else Reflect.deleteProperty(globalThis, 'crypto');
  }
});

test('a snoozed step refuses Done until expiry, while an expired snooze can be answered', async () => {
  writes.length = reads.length = 0;
  const snoozed = { ...open, snoozedUntil: new Date(Date.now() + 60_000).toISOString() };
  expect(await changeInboxStep(snoozed, false, dependencies(async () => done))).toEqual({ state: 'refused' });
  expect(writes).toEqual([]); expect(reads).toEqual([]);
  const expired = { ...snoozed, snoozedUntil: new Date(Date.now() - 60_000).toISOString() };
  expect(await changeInboxStep(expired, false, dependencies(async () => done))).toEqual({ state: 'stored', item: done });
  expect(writes).toHaveLength(1); expect(reads).toEqual([]);
});

test('known unsupported answer 501 is refused without read; lost stored acknowledgement 502 remains uncertain with one read', async () => {
  for (const [status, code] of [[501, 'smarty.inbox-guard-unavailable'], [501, 'other-unsupported'], [502, 'smarty.inbox-guard-unavailable']] as const) {
    writes.length = reads.length = 0;
    const refused = status === 501 && code === 'smarty.inbox-guard-unavailable';
    const message = refused ? 'Guarded answer unavailable; nothing sent' : 'Stored acknowledgement unavailable';
    const deps = dependencies(async () => done);
    deps.write = (id, action, body) => actOnInboxItem(id, action, body, async () => {
      writes.push({ id, action, body });
      return Response.json({ data: { message, code } }, { status });
    });
    expect(await changeInboxStep(open, false, deps)).toEqual(refused
      ? { state: 'refused', error: message } : { state: 'uncertain', item: done });
    expect(writes).toHaveLength(1); expect(reads).toHaveLength(refused ? 0 : 1);
  }
});

test('generic Inbox responses retain their text and share the one-read no-replay guard', async () => {
  for (const uncertain of [false, true]) {
    writes.length = reads.length = 0;
    const response = { ...done, answer: { ...stamp, text: 'A generic response' } };
    const result = await actOnInboxStep(open, 'answer', { text: response.answer.text, action: 'respond' },
      dependencies(async () => { if (uncertain) throw new InboxRequestError('ack unavailable', true); return response; }, async () => response));
    expect(result).toEqual({ state: uncertain ? 'uncertain' : 'stored', item: response });
    expect(writes).toEqual([{ id: open.id, action: 'answer', body: {
      text: 'A generic response', action: 'respond', updated: open.updated, opKey: 'one-operation',
    } }]);
    expect(reads).toHaveLength(uncertain ? 1 : 0);
  }
});

test('generic resolved states cannot be marked Done or undone by the Steps action', async () => {
  const resolved = { ...open, resolved: { at: 'v2', by: 'agent', action: 'ignore' } };
  writes.length = reads.length = 0;
  for (const undo of [false, true]) expect((await changeInboxStep(resolved, undo, dependencies(async () => done))).state).toBe('refused');
  expect(writes).toEqual([]); expect(reads).toEqual([]);
});
