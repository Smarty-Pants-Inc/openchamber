import './native-test-network';
import { expect, test } from 'bun:test';
import type { TextPart, ToolPart } from '@opencode-ai/sdk/v2/client';
import { fixture, record, target } from './localCompletion675.fixture';
import { interruptedTurnToolParts } from './sync-context';
import { isUnsaved, keepReadMetadata, messageMetadataRevision } from './unsaved';

for (const caller of ['idle', 'error', 'snapshot'] as const) {
  for (const [label, pageRevision, liveRevision] of [
    ['absent', undefined, undefined], ['equal', 7, 7], ['lower page', 7, 8],
  ] satisfies [string, number | undefined, number | undefined][]) {
    test(`${caller} completion retains live saved metadata across held initial page, ${label}`, async () => {
      const f = fixture(), page = record(true, pageRevision), live = record(false, liveRevision);
      const read = await f.start([page], true);
      f.live(page.info); f.live(live.info);
      const shown = f.shown()[0], before = messageMetadataRevision();
      expect(isUnsaved(shown)).toBe(false);
      await f.settle(caller);
      const completed = f.shown()[0];
      expect(completed).not.toBe(shown);
      expect(completed).toMatchObject({ id: live.info.id, time: { created: 101 }, error: { name: 'MessageAbortedError', data: { message: 'aborted' }, message: 'aborted' } });
      expect(completed.role === 'assistant' ? completed.time.completed : undefined).toBeGreaterThan(0);
      expect(messageMetadataRevision()).toBe(before);
      read.release(); await read.done;
      expect(f.shown()).toHaveLength(1);
      expect(isUnsaved(f.shown()[0])).toBe(false);
      expect(f.shown()[0]).toBe(completed);
      expect(f.reads).toHaveLength(1);
      expect(f.statusReads).toHaveLength(caller === 'snapshot' ? 1 : 0);
      // A later read is fresh authority. It can make the same row unsaved without undoing completion.
      await f.load([record(true, liveRevision)]);
      expect(isUnsaved(f.shown()[0])).toBe(true);
      expect(f.shown()[0]).toMatchObject({ time: completed.time, error: { name: 'MessageAbortedError' } });
      expect(f.reads).toHaveLength(2);
    });
  }
  for (const revision of [undefined, 7]) {
    test(`${caller} equivalent completion cannot veto an already fresh save-state page, revision ${revision ?? 'absent'}`, async () => {
      const f = fixture(), saved = record(false, revision);
      f.live(saved.info);
      const read = await f.start([record(true, revision)], true), before = messageMetadataRevision();
      await f.settle(caller);
      expect(messageMetadataRevision()).toBe(before);
      const completed = f.shown()[0];
      read.release(); await read.done;
      expect(isUnsaved(f.shown()[0])).toBe(true);
      expect(f.shown()[0]).toMatchObject({ time: completed.time, error: { name: 'MessageAbortedError' } });
      expect(f.reads).toHaveLength(1);
      expect(f.statusReads).toHaveLength(caller === 'snapshot' ? 1 : 0);
    });
    for (const initialUnsaved of [false, true]) {
      test(`${caller} carries same-ID ${initialUnsaved ? 'unsaved/saved/unsaved' : 'saved/unsaved/saved'} ABA ownership, revision ${revision ?? 'absent'}`, async () => {
        const f = fixture(), a = record(initialUnsaved, revision), b = record(!initialUnsaved, revision);
        f.live(a.info);
        const read = await f.start([b], true);
        f.live(b.info); f.live(a.info); // Reuse the earlier raw A payload.
        const before = messageMetadataRevision();
        expect(isUnsaved(f.shown()[0])).toBe(initialUnsaved);
        await f.settle(caller);
        const completed = f.shown()[0];
        expect(messageMetadataRevision()).toBe(before);
        read.release(); await read.done;
        expect(f.shown()[0]).toBe(completed);
        expect(isUnsaved(f.shown()[0])).toBe(initialUnsaved);
        f.live(b.info); // Live metadata ownership still accepts the opposite save state.
        expect(isUnsaved(f.shown()[0])).toBe(!initialUnsaved);
        f.live(a.info);
        expect(isUnsaved(f.shown()[0])).toBe(initialUnsaved);
        expect(f.reads).toHaveLength(1);
      });
    }
  }
  test(`${caller} completion does not overrule a held page's higher native revision`, async () => {
    const f = fixture(), read = await f.start([record(true, 9)], true);
    f.live(record(true, 7).info); f.live(record(false, 8).info);
    await f.settle(caller);
    const completed = f.shown()[0];
    read.release(); await read.done;
    expect(isUnsaved(f.shown()[0])).toBe(true);
    expect(f.shown()[0]).toMatchObject({ time: completed.time, error: { name: 'MessageAbortedError' } });
    expect(f.reads).toHaveLength(1);
  });
}

test('completion carries the row revision without advancing or changing unrelated references and fields', () => {
  const f = fixture(), sibling = record(true, 7), live = record(false, 7);
  f.live(sibling.info); const baseline = messageMetadataRevision(); f.live(live.info);
  const shown = f.shown()[0], before = messageMetadataRevision();
  const siblingRow = { ...live.info, id: 'msg_earlier_675', time: { created: 100, completed: 102 } };
  const text: TextPart = { id: 'text', messageID: shown.id, sessionID: target.sessionID, type: 'text', text: 'reply' };
  const running: ToolPart = { id: 'running', messageID: shown.id, sessionID: target.sessionID, type: 'tool', callID: 'running', tool: 'bash',
    state: { status: 'running', input: {}, time: { start: 1000 } } };
  const pending: ToolPart = { ...running, id: 'pending', callID: 'pending', state: { status: 'pending', input: {}, raw: '' } };
  const finished: ToolPart = { ...running, id: 'finished', callID: 'finished',
    state: { status: 'completed', input: {}, output: 'done', title: 'done', metadata: {}, time: { start: 1000, end: 2000 } } };
  const state = { ...f.store.getState(), message: { [target.sessionID]: [siblingRow, shown] },
    part: { [shown.id]: [text, running, pending, finished] }, session_status: { [target.sessionID]: { type: 'idle' as const } } };
  const result = interruptedTurnToolParts(state, target.sessionID, 5000);
  expect(result?.messages[1]).toMatchObject({ ...live.info, time: { created: 101, completed: 5000 }, error: { name: 'MessageAbortedError' } });
  expect(messageMetadataRevision()).toBe(before);
  expect(result).not.toBeNull();
  if (!result) throw new Error('Completion was not published');
  expect(result.messages[0]).toBe(siblingRow);
  expect(result.parts?.[0]).toBe(text);
  expect(result.parts?.[1]).toMatchObject({ state: { status: 'error', error: 'Interrupted', time: { start: 1000, end: 5000 } } });
  expect(result.parts?.[2]).toMatchObject({ state: { status: 'error', error: 'Interrupted', time: { start: 5000, end: 5000 } } });
  expect(result.parts?.[3]).toBe(finished);
  expect(state.part[shown.id][1]).toBe(running);
  expect(keepReadMetadata(result.messages[1], sibling.info, baseline)).toBe(result.messages[1]);
  expect(interruptedTurnToolParts({ ...state, message: { [target.sessionID]: result.messages } }, target.sessionID, 6000)).toBeNull();
  expect(shown.time).toEqual({ created: 101 });
  expect(f.reads).toHaveLength(0);
});

test('ordinary-marked idle still removes unfinished streamed copies without advancing metadata authority', async () => {
  const f = fixture();
  const unfinished = record(true, 8), saved = record(false, 8);
  const finished = { ...saved.info, id: 'msg_finished_675', time: { created: 100, completed: 102 } };
  f.live(finished); f.live(unfinished.info);
  const status = { type: 'busy' as const, ordinary: true, ordinaryTarget: { generation: '675', presentationId: '675' } };
  f.event({ id: 'ordinary-busy', type: 'session.status', properties: { sessionID: target.sessionID, status } });
  const before = messageMetadataRevision();
  await f.settle('idle');
  expect(f.shown()).toEqual([finished]);
  expect(f.shown()[0]).toBe(finished);
  expect(messageMetadataRevision()).toBe(before);
  expect(f.reads).toHaveLength(0);
});
