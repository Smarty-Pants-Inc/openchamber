import { expect, test } from 'bun:test';
import { act } from 'react';
import { container, entry, markPendingUserSendAnimation, optimisticMessageRecords, positions, render,
  sessionKey, settleVisible, stepFrame, visibility, withoutSupersededOptimistic, list, measureRowHeight } from './MessageList.continuity.fixture';

test('already visible optimistic C stays visible when exact linked native E becomes displayable', async () => {
  await render([]);
  const pending = entry('C'); optimisticMessageRecords.add(pending.info);
  markPendingUserSendAnimation(sessionKey);
  await render([pending]); await settleVisible('C');
  const native = entry('E', 'C');
  await render(withoutSupersededOptimistic([pending, { ...native, parts: [] }]));
  expect(visibility('C')).toEqual([]);
  await render(withoutSupersededOptimistic([pending, native]));
  expect(container.querySelector('[data-message-id="C"]')).toBeNull();
  expect(visibility('E')).toEqual([]);
  for (let i = 0; i < 8; i++) { await stepFrame(); expect(visibility('E')).toEqual([]); }
});

test('a genuinely new own append may reveal before becoming visible', async () => {
  await render([]);
  markPendingUserSendAnimation(sessionKey);
  await render([entry('new')]);
  // Continuity forbids hiding an existing bubble, not the initial reveal of a new one.
  await settleVisible('new');
  expect(visibility('new')).toEqual([]);
});

test('unlinked same-content native rows keep both identities, not a heuristic replacement', async () => {
  const pending = entry('C'); optimisticMessageRecords.add(pending.info);
  await render(withoutSupersededOptimistic([pending, entry('unlinked')]));
  await settleVisible('C'); await settleVisible('unlinked');
  expect(visibility('C')).toEqual([]); expect(visibility('unlinked')).toEqual([]);
});

test('first positioned materialization and genuine branch epoch still replace the real list', async () => {
  const message = entry('branch-row');
  await render([message]); await settleVisible('branch-row');
  const unpositioned = container.querySelector('[data-scrollbar="chat"]');
  await render([message], positions('first-positioned'));
  expect(container.querySelector('[data-scrollbar="chat"]')).not.toBe(unpositioned);
  await settleVisible('branch-row');
  const positioned = container.querySelector('[data-scrollbar="chat"]');
  await render([message], positions('real-branch-replacement'));
  expect(container.querySelector('[data-scrollbar="chat"]')).not.toBe(positioned);
  await settleVisible('branch-row');
});

test('an offscreen armed C is not reanimated after native E becomes visible and durable alias C returns', async () => {
  measureRowHeight(320);
  const old = Array.from({ length: 60 }, (_, i) => entry(`old-${i}`));
  await render(old); await settleVisible('old-59');
  await act(async () => { await list().scrollToIndex({ index: 0, animated: false }); });
  for (let i = 0; i < 8; i++) await stepFrame();
  expect(list().getState().isAtEnd).toBe(false);
  const pending = entry('C'); optimisticMessageRecords.add(pending.info);
  markPendingUserSendAnimation(sessionKey);
  await render([...old, pending]);
  expect(container.querySelector('[data-message-id="C"]')).toBeNull();
  const native = entry('E', 'C');
  await render(withoutSupersededOptimistic([...old, pending, native]));
  let endScroll = Promise.resolve();
  await act(async () => { endScroll = list().scrollToEnd({ animated: false }); });
  for (let i = 0; i < 15; i++) await stepFrame();
  await endScroll;
  await settleVisible('E');
  expect(visibility('E')).toEqual([]);
  await render([...old, entry('C')]);
  expect(visibility('C')).toEqual([]);
});

test('visible raw E stays visible when durable alias C changes positions epoch', async () => {
  await render([entry('E', 'C')], positions('raw-epoch', 'native-history')); await settleVisible('E');
  const scroller = container.querySelector('[data-scrollbar="chat"]');
  await render([entry('E', 'C')], { ...positions('durable-epoch', 'native-history'), ranges: [] });
  expect(container.querySelector('[data-scrollbar="chat"]')).toBe(scroller);
  expect(visibility('E')).toEqual([]);
  for (let i = 0; i < 8; i++) { await stepFrame(); expect(visibility('E')).toEqual([]); }
  await render([entry('C')], positions('durable-epoch', 'native-history'));
  expect(visibility('C')).toEqual([]);
  expect(container.querySelector('[data-scrollbar="chat"]')).toBe(scroller);
  expect(container.querySelectorAll('[data-message-id="C"]')).toHaveLength(1);
  expect(container.querySelector('[data-message-id="E"]')).toBeNull();
  for (let i = 0; i < 8; i++) { await stepFrame(); expect(visibility('C')).toEqual([]); }
});
