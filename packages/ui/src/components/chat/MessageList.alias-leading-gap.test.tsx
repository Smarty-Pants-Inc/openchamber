import { expect, test } from 'bun:test';
import { act } from 'react';
import { mount, record, type FullRecord } from './MessageList.tail-gap.fixture';
import { container, entry, list, measureRowHeight, measureRowTop, render, settleVisible, stepFrame } from './MessageList.continuity.fixture';
import type { SessionPositions } from '@/sync/session-message-loader';
type Snapshot = ReturnType<Awaited<ReturnType<typeof mount>>['observe']>;
const identity = ({ list, scroller }: Snapshot) => ({ list, scroller });
const alias = () => {
  const e = record('E', 1, 'C'), c = record('C', 1);
  Object.assign(e.info, { metadata: { pi: { entryID: 'E' }, smartyCodeEchoOf: 'C' } });
  Object.assign(c.info, { metadata: { pi: { entryID: 'E' } } });
  return { e, c };
};
const full = (snapshot: Snapshot, storeIDs: string[], hookIDs = storeIDs) => {
  expect(snapshot.store.map(row => row.id)).toEqual(storeIDs);
  expect(snapshot.hooks.map(row => row.id)).toEqual(hookIDs);
  for (const source of [snapshot.store, snapshot.hooks]) {
    for (const row of source) expect(row.parts.some(part => part.type === 'text' && part.displayable)).toBe(true);
  }
  for (const request of snapshot.requests) {
    expect(request.method).toBe('GET');
    expect(request.path).toBe('/session/tail-gap-session/message');
    expect(request.query).toContain('directory=%2Ftail-gap-fixture');
    for (const row of request.records) expect(row.parts.some(part => part.displayable)).toBe(true);
  }
};
const visible = (snapshot: Snapshot, ids: string[]) => {
  for (const id of ids) expect(snapshot.rows.find(row => row.id === id)).toMatchObject({ glyphs: 1, hidden: [] });
};
// Read actual Legend PositionView DOM output. Never replace measurement, positions, keys or list state.
// Happy DOM rects are synthetic; Legend's assigned absolute top is the ordering signal, not those rects.
const descriptor = (selector: string) => {
  const node = container.querySelector<HTMLElement>(selector);
  if (!node) throw new Error(`NOT RED: missing DOM prerequisite ${selector}`);
  const ancestors: Array<{ tag: string; style: string | null; className: string }> = [];
  let positionNode: HTMLElement | null = null;
  for (let parent: HTMLElement | null = node; parent && parent !== container; parent = parent.parentElement) {
    ancestors.push({ tag: parent.tagName, style: parent.getAttribute('style'), className: parent.className });
    if (!positionNode && parent.style.position === 'absolute' && parent.style.top !== '') positionNode = parent;
  }
  const top = Number.parseFloat(positionNode?.style.top ?? '');
  if (!positionNode || !Number.isFinite(top)) throw new Error(`NOT RED: no actual Legend absolute position for ${selector}`);
  return { node, positionNode, top, ancestors };
};
const ordering = (id: string) => {
  const gap = descriptor('[data-history-gap="0-3"]');
  const content = descriptor(`[data-message-id="${id}"]`);
  if (gap.positionNode === content.positionNode) throw new Error('NOT RED: descriptors selected the same container');
  return { id, gap: { range: gap.node.getAttribute('data-history-gap'), height: gap.node.style.height,
    top: gap.top, ancestors: gap.ancestors }, content: { top: content.top, ancestors: content.ancestors },
    documentPosition: gap.node.compareDocumentPosition(content.node), gapBeforeContent: gap.top < content.top };
};
const sample = async (s: Awaited<ReturnType<typeof mount>>, label: string, id: string) => {
  const snapshot = await s.frame(label), layout = ordering(id);
  console.log('LEGEND_DOM_LAYOUT', JSON.stringify({ label, layout }));
  return { snapshot, layout };
};
const body = async (s: Awaited<ReturnType<typeof mount>>, c: FullRecord) => {
  await s.info(c);
  for (const part of c.parts) await s.part(part);
};
// Controls finish and release their roots, loaders, stores and held HTTP before the final target.
test('control: full raw leading gap stays before E across an empty-coverage fence', async () => {
  const { e } = alias(); const s = await mount([e], 3, 4);
  try {
    await s.settle('E'); const before = await sample(s, 'CONTROL raw P/H', 'E');
    full(before.snapshot, ['E']); visible(before.snapshot, ['E']);
    expect(before.snapshot.rows[0].position).toBe(3);
    expect(before.layout.gapBeforeContent).toBe(true);
    expect(before.layout.gap.height).toBe('240px');
    s.configure([e], 'Q', 'H', 3, 4); s.hold(); await s.index('Q', 4);
    const fence = await sample(s, 'CONTROL raw Q/H held', 'E');
    expect(fence.snapshot.positions).toEqual({ total: 4, epoch: 'Q', historyEpoch: 'H', ranges: [] });
    full(fence.snapshot, ['E']); visible(fence.snapshot, ['E']);
    expect(identity(fence.snapshot)).toEqual(identity(before.snapshot));
    expect(fence.layout.gapBeforeContent).toBe(true);
    await s.release(); await s.settle('E');
    const accepted = await sample(s, 'CONTROL raw Q/H coherent', 'E');
    expect(accepted.layout.gapBeforeContent).toBe(true);
    expect(identity(accepted.snapshot)).toEqual(identity(before.snapshot));
    expect(accepted.snapshot.positions).toEqual({ total: 4, epoch: 'Q', historyEpoch: 'H', ranges: [{ start: 3, end: 4 }] });
  } finally { await s.close(); }
}, 15000);

test('control: no-leading-gap alias adoption keeps one full C glyph through held and coherent HTTP', async () => {
  const { e, c } = alias(); const s = await mount([e]);
  try {
    await s.settle('E'); const before = s.observe(); full(before, ['E']); visible(before, ['E']);
    s.configure([c]); s.hold(); await s.index('Q', 1);
    await body(s, c); await s.remove('E'); await s.settle('C');
    const fence = await s.frame('CONTROL zero-leading-gap C Q/H held');
    full(fence, ['C']); visible(fence, ['C']); expect(fence.gaps).toBe(0);
    expect(fence.positions).toEqual({ total: 1, epoch: 'Q', historyEpoch: 'H', ranges: [] });
    expect(identity(fence)).toEqual(identity(before));
    await s.release(); await s.settle('C');
    const accepted = await s.frame('CONTROL zero-leading-gap C coherent');
    full(accepted, ['C']); visible(accepted, ['C']); expect(accepted.gaps).toBe(0);
    expect(identity(accepted)).toEqual(identity(before));
    expect(accepted.positions).toEqual({ total: 1, epoch: 'Q', historyEpoch: 'H', ranges: [{ start: 0, end: 1 }] });
  } finally { await s.close(); }
}, 15000);

test('control: genuine history and coherent leading-gap correction still replace the real layout', async () => {
  const { e } = alias(); const s = await mount([e], 3, 4);
  try {
    await s.settle('E'); const before = await sample(s, 'CONTROL history initial', 'E');
    s.configure([e], 'Q', 'J', 3, 4); s.hold(); await s.index('Q', 4, 'J');
    const fence = await sample(s, 'CONTROL genuine history held', 'E');
    expect(identity(fence.snapshot)).toEqual(identity(before.snapshot));
    expect(fence.layout.gapBeforeContent).toBe(true);
    await s.release(); await s.settle('E');
    const history = await sample(s, 'CONTROL genuine history coherent', 'E');
    full(history.snapshot, ['E']); visible(history.snapshot, ['E']);
    expect(history.layout.gapBeforeContent).toBe(true);
    expect(history.snapshot.list).not.toBe(before.snapshot.list);
    expect(history.snapshot.scroller).not.toBe(before.snapshot.scroller);
    const older = [record('older-0', -3), record('older-1', -2), record('older-2', -1)];
    s.configure([...older, e], 'R', 'J', 0, 4); s.hold(); await s.index('R', 4, 'J');
    await s.release(); await s.settle('E');
    const corrected = await s.frame('CONTROL coherent leading gap removed');
    full(corrected, [...older.map(row => row.info.id), 'E']);
    expect(corrected.gaps).toBe(0);
    expect(corrected.list).not.toBe(history.snapshot.list);
    expect(corrected.scroller).not.toBe(history.snapshot.scroller);
  } finally { await s.close(); }
}, 15000);

test('control: public Legend reader restore keeps a nonzero offset on real history/layout replacement', async () => {
  // Existing continuity environment and public MessageList props only. This control isolates reader restoration;
  // the alias target below instead gets all message and position authority from the real SDK loader and events.
  measureRowHeight(320);
  const messages = Array.from({ length: 40 }, (_, i) => entry(`reader-${i}`));
  await render(messages); await settleVisible('reader-39');
  await act(async () => { await list().scrollToIndex({ index: 10, viewOffset: -37, animated: false }); });
  for (let i = 0; i < 8; i++) await stepFrame();
  const before = list().getState(); expect(before.isAtEnd).toBe(false);
  const key = before.data[before.start].key; measureRowTop(-37);
  const positionOf = (id: string) => messages.findIndex(row => row.info.id === id) + 17360;
  const positions: SessionPositions = { total: 17400, ranges: [{ start: 17360, end: 17400 }], epoch: 'P', historyEpoch: 'H' };
  const scroller = list().getScrollableNode();
  await render(messages, positions, positionOf);
  for (let i = 0; i < 15; i++) await stepFrame();
  expect(list().getScrollableNode()).not.toBe(scroller);
  const restored = list().getState(), index = restored.data.findIndex(row => row.key === key);
  expect(restored.isAtEnd).toBe(false); expect(index).toBeGreaterThanOrEqual(0);
  expect(restored.scroll).toBe(restored.positionAtIndex(index) + 37);
  const branchScroller = list().getScrollableNode();
  await render(messages, { ...positions, epoch: 'Q', historyEpoch: 'J' }, positionOf);
  for (let i = 0; i < 15; i++) await stepFrame();
  const branched = list().getState(), branchIndex = branched.data.findIndex(row => row.key === key);
  expect(list().getScrollableNode()).not.toBe(branchScroller);
  expect(branched.isAtEnd).toBe(false);
  expect(branched.scroll).toBe(branched.positionAtIndex(branchIndex) + 37);
  console.log('CONTROL_READER_RESTORE', JSON.stringify({ key, offset: -37, restoredScroll: restored.scroll,
    restoredPosition: restored.positionAtIndex(index), branchScroll: branched.scroll, branchPosition: branched.positionAtIndex(branchIndex) }));
}, 15000);
test('native E to canonical C must keep the complete leading gap BEFORE its content while Q/H HTTP is held', async () => {
  const { e, c } = alias(); const s = await mount([e], 3, 4);
  const frames: Awaited<ReturnType<typeof sample>>[] = [];
  try {
    await s.settle('E'); const before = await sample(s, 'TARGET 0 full E P/H native-entry E target C at 3', 'E');
    full(before.snapshot, ['E']); visible(before.snapshot, ['E']);
    expect(before.snapshot.positions).toEqual({ total: 4, epoch: 'P', historyEpoch: 'H', ranges: [{ start: 3, end: 4 }] });
    expect(before.snapshot.rows[0].position).toBe(3);
    expect(before.layout.gapBeforeContent).toBe(true); expect(before.layout.gap.height).toBe('240px');
    s.configure([c], 'Q', 'H', 3, 4); s.hold(); await s.index('Q', 4);
    const fence = await sample(s, 'TARGET 1 session.index Q/H full canonical HTTP held', 'E');
    full(fence.snapshot, ['E']); visible(fence.snapshot, ['E']);
    expect(fence.snapshot.positions).toEqual({ total: 4, epoch: 'Q', historyEpoch: 'H', ranges: [] });
    expect(fence.layout.gapBeforeContent).toBe(true);
    expect(fence.snapshot.requests.length).toBeGreaterThan(1);
    await s.info(c);
    const info = await sample(s, 'TARGET 2 canonical INFO only raw E still displayable', 'E');
    expect(info.snapshot.store.map(row => row.id)).toEqual(['C', 'E']);
    visible(info.snapshot, ['E']); expect(info.layout.gapBeforeContent).toBe(true);
    for (const part of c.parts) await s.part(part);
    await s.settle('C');
    frames.push(await sample(s, 'TARGET 3 full canonical PART before raw removal', 'C'));
    full(frames[0].snapshot, ['C', 'E'], ['C']); visible(frames[0].snapshot, ['C']);
    expect(container.querySelector('[data-message-id="E"]')).toBeNull();
    await s.remove('E');
    frames.push(await sample(s, 'TARGET 4 raw E removed through actual handleEvent', 'C'));
    for (let i = 0; i < 3; i++) frames.push(await sample(s, `TARGET 5.${i} C held-HTTP synthetic frame`, 'C'));
    for (const { snapshot, layout } of frames) {
      full(snapshot, snapshot === frames[0].snapshot ? ['C', 'E'] : ['C'], ['C']); visible(snapshot, ['C']);
      expect(snapshot.positions).toEqual({ total: 4, epoch: 'Q', historyEpoch: 'H', ranges: [] });
      expect(snapshot.rows[0].position).toBeUndefined();
      expect(snapshot.gaps).toBe(1); expect(layout.gap.range).toBe('0-3'); expect(layout.gap.height).toBe('240px');
      expect(identity(snapshot)).toEqual(identity(before.snapshot));
      expect(snapshot.requests.at(-1)).toMatchObject({ epoch: 'Q', history: 'H', at: 3, total: 4, records: [{ id: 'C' }] });
    }
    console.log('ALIAS_LEADING_GAP_FACTS', JSON.stringify({ eventOrder: ['HTTP E P/H at=3 total=4', 'hold canonical HTTP',
      'session.index Q/H', 'message.updated C', 'message.part.updated C full glyph', 'message.removed E'], frames,
      syntheticGeometry: true, actualPaintClaim: false, recordedCauseClaim: false, nativeProviderQualified: false }));
  } finally { await s.close(); }
  // All controls/prerequisites and owned target cleanup complete BEFORE the only expected semantic RED.
  // A preserved count of one is insufficient: the real Legend row coordinate must stay before C.
  expect(frames.map(frame => frame.layout.gapBeforeContent)).toEqual(frames.map(() => true));
}, 15000);
