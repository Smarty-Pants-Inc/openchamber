import { expect, test } from 'bun:test';
import { act } from 'react';
import { container, entry, list, measureRowHeight, measureRowTop, positions, render, settleVisible, stepFrame, visibility } from './MessageList.continuity.fixture';
import type { SessionPositions } from '@/sync/session-message-loader';

test('same-total native rewrites including invisible ancestors remount even with unchanged positional epoch', async () => {
  await render([entry('same-row')], positions('position-one', 'native-one')); await settleVisible('same-row');
  const scroller = container.querySelector('[data-scrollbar="chat"]');
  await render([entry('same-row')], { ...positions('position-one', 'native-two'), ranges: [] });
  expect(container.querySelector('[data-scrollbar="chat"]')).toBe(scroller);
  await render([entry('same-row')], positions('position-one', 'native-two'));
  expect(container.querySelector('[data-scrollbar="chat"]')).not.toBe(scroller);
  await settleVisible('same-row');
});

test('first native huge-gap layout initializes once; transient empty coverage preserves real gaps and visible glyphs', async () => {
  await render([entry('tail')]); await settleVisible('tail');
  const plain = container.querySelector('[data-scrollbar="chat"]');
  const indexed: SessionPositions = { total: 17_400, ranges: [{ start: 17_399, end: 17_400 }], epoch: 'position-one', historyEpoch: 'native-one' };
  await render([entry('tail')], indexed, () => 17_399); await settleVisible('tail');
  const scroller = container.querySelector('[data-scrollbar="chat"]');
  expect(scroller).not.toBe(plain);
  const contentLength = list().getState().contentLength;
  expect(contentLength).toBeGreaterThan(1_000_000);
  await render([entry('tail')], { ...indexed, epoch: 'position-two', ranges: [] }, () => undefined);
  expect(container.querySelector('[data-scrollbar="chat"]')).toBe(scroller);
  expect(list().getState().contentLength).toBe(contentLength);
  expect(visibility('tail')).toEqual([]);
  for (let i = 0; i < 8; i++) { await stepFrame(); expect(visibility('tail')).toEqual([]); }
  await render([entry('tail')], { ...indexed, epoch: 'position-two' }, () => 17_399);
  expect(container.querySelector('[data-scrollbar="chat"]')).toBe(scroller);
  expect(visibility('tail')).toEqual([]);
});

test('same native history does not waive a committed positional gap-layout correction', async () => {
  await render([entry('tail')], positions('position-one', 'native-one')); await settleVisible('tail');
  const scroller = container.querySelector('[data-scrollbar="chat"]');
  await render([entry('tail')], { total: 10_000, ranges: [{ start: 9_999, end: 10_000 }], epoch: 'position-two', historyEpoch: 'native-one' }, () => 9_999);
  expect(container.querySelector('[data-scrollbar="chat"]')).not.toBe(scroller);
  await settleVisible('tail');
});

test('real branch remount restores a scrolled reader with nonzero measured offset, then missing-anchor rewrite falls back to end', async () => {
  // Match actual measurements to estimates so this control isolates anchor restoration, not size convergence.
  measureRowHeight(320);
  const messages = Array.from({ length: 40 }, (_, i) => entry(`reader-${i}`));
  const indexed: SessionPositions = { total: 40, ranges: [{ start: 0, end: 40 }], epoch: 'position-one', historyEpoch: 'native-one' };
  const positionOf = (id: string) => messages.findIndex((message) => message.info.id === id);
  await render(messages); await settleVisible('reader-39');
  await act(async () => { await list().scrollToIndex({ index: 10, viewOffset: -37, animated: false }); });
  for (let i = 0; i < 8; i++) await stepFrame();
  const before = list().getState();
  expect(before.isAtEnd).toBe(false);
  const anchorKey = before.data[before.start].key;
  measureRowTop(-37);
  const scroller = container.querySelector('[data-scrollbar="chat"]');
  // First positioning inserts 17k real gap records above the scrolled reader, without zeroing their offset.
  const huge: SessionPositions = { ...indexed, total: 17_400, ranges: [{ start: 17_360, end: 17_400 }] };
  const hugePositionOf = (id: string) => positionOf(id) + 17_360;
  await render(messages, huge, hugePositionOf);
  expect(container.querySelector('[data-scrollbar="chat"]')).not.toBe(scroller);
  for (let i = 0; i < 15; i++) await stepFrame();
  const restored = list().getState();
  const anchorIndex = restored.data.findIndex((row) => row.key === anchorKey);
  expect(restored.isAtEnd).toBe(false);
  expect(restored.scroll).toBe(restored.positionAtIndex(anchorIndex) + 37);
  const branchScroller = container.querySelector('[data-scrollbar="chat"]');
  await render(messages, { ...huge, epoch: 'position-two', historyEpoch: 'native-two' }, hugePositionOf);
  expect(container.querySelector('[data-scrollbar="chat"]')).not.toBe(branchScroller);
  for (let i = 0; i < 15; i++) await stepFrame();
  const branched = list().getState();
  expect(branched.isAtEnd).toBe(false);
  const branchedIndex = branched.data.findIndex((row) => row.key === anchorKey);
  expect(branched.scroll).toBe(branched.positionAtIndex(branchedIndex) + 37);
  const replacements = messages.map((_, i) => entry(`replacement-${i}`));
  await render(replacements, { ...huge, epoch: 'position-three', historyEpoch: 'native-three' },
    (id) => replacements.findIndex((message) => message.info.id === id) + 17_360);
  await settleVisible('replacement-39');
  expect(list().getState().isAtEnd).toBe(true);
});
