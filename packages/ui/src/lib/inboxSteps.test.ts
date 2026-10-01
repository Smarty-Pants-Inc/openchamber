import { expect, test } from 'bun:test';
import { groupInboxSteps, isStepDone, stepCopyTarget, STEP_DONE_REPORT, selectStepList } from './inboxSteps';
import type { InboxItem } from './smartyInbox';

export const step = (ordinal = 1, over: Partial<InboxItem> = {}): InboxItem => ({
  id: `step:${ordinal}`, to: 'paul', title: 'Release — Run the check', actions: ['respond'], links: [], priority: 'normal',
  created: '2026-09-30T10:00:00Z', updated: '2026-09-30T10:00:00Z', source: `steps:v1:release:${String(ordinal).padStart(2, '0')}/03`,
  recommendation: '  printf "%s" "é"  ', ...over,
});

test('recipient-scoped groups are ordinal ordered and incomplete until all ordinals arrive', () => {
  const partial = groupInboxSteps([step(3), step(1)]);
  expect(partial[0]).toMatchObject({ total: 3, complete: false, topic: 'Release' });
  expect(partial[0]?.steps.map(s => s.ordinal)).toEqual([1, 3]);
  expect(groupInboxSteps([step(3), step(1), step(2)])[0]?.complete).toBe(true);
  expect(groupInboxSteps([step(1), step(1, { to: 'other' })])).toHaveLength(2);
});

test('malformed tags, duplicate ordinals, inconsistent totals, topics and action contracts never make checklists', () => {
  for (const source of ['steps:v1:release:1/03', 'steps:v1:release:00/03', 'steps:v1:release:04/03', 'steps:v1:release:01/00', 'steps:v1:release:01/03:extra']) {
    expect(groupInboxSteps([step(1), step(2, { source }), step(3)])).toEqual([]);
  }
  for (const bad of [step(2, { source: 'steps:v1:release:02/04' }), step(1, { id: 'duplicate' }),
    step(2, { title: 'Different — instruction' }), step(2, { actions: ['accept', 'respond'] })]) {
    expect(groupInboxSteps([step(1), bad, step(3)])).toEqual([]);
  }
  expect(groupInboxSteps([step(1, { source: 'steps:v2:release:01/03' })])).toEqual([]);
  expect(groupInboxSteps([step(1, { source: 'steps:v1:bad id:01/01' })])).toEqual([]);
});

test('new arrivals preserve selected list; an invalidated selection falls back to the next valid group', () => {
  const first = groupInboxSteps([step(1)]);
  const second = groupInboxSteps([step(1, { id: 'other', source: 'steps:v1:other:01/01', title: 'Other — next' }), step(1)]);
  expect(selectStepList(second, first[0]!.key)?.key).toBe(first[0]!.key);
  expect(selectStepList(first, 'missing')?.key).toBe(first[0]!.key);
});

test('Done requires the stored exact answer and recipient actor, not generic resolution, ignore, withdrawal or approval', () => {
  const answer = { at: '2026-09-30T11:00:00Z', by: 'paul', action: 'respond', text: STEP_DONE_REPORT };
  const resolved = { at: answer.at, by: 'paul', action: 'respond' };
  expect(isStepDone(step(1, { answer, resolved }))).toBe(true);
  for (const over of [{ resolved }, { answer }, { answer: { ...answer, by: 'agent' }, resolved },
    { answer: { ...answer, text: 'approved' }, resolved }, { answer, resolved: { ...resolved, action: 'ignore' } },
    { answer, resolved: { ...resolved, by: 'agent' } }]) expect(isStepDone(step(1, over))).toBe(false);
});

test('Copy preserves every raw byte in a line and refuses controls instead of sanitizing executable text', () => {
  const raw = '  printf "%s" "é"  $ literal ```sh smart “quote”';
  expect(stepCopyTarget(raw)).toEqual({ text: raw, safe: true });
  for (const control of ['\n', '\u001b', '\r', '\t', '\u0000', '\u007f', '\u009b', '\u061c', '\u200b', '\u200e', '\u202e', '\u202c', '\u2066', '\u2069', '\ufeff', '\u2028', '\u2029', '\u{e0001}']) {
    expect(stepCopyTarget(`safe${control}unsafe`)).toEqual({ text: `safe${control}unsafe`, safe: false });
  }
});
