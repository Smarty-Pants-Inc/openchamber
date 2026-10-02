import { expect, test } from 'bun:test';
import { mount, record } from './MessageList.tail-gap.fixture';

type Snapshot = ReturnType<Awaited<ReturnType<typeof mount>>['observe']>;
const identity = ({ list, scroller }: Snapshot) => ({ list, scroller });
const full = (snapshot: Snapshot, ids: string[]) => {
  for (const source of [snapshot.store, snapshot.hooks]) {
    expect(source.map((item) => item.id)).toEqual(ids);
    for (const item of source) expect(item.parts.some((part) => part.type === 'text' && part.displayable)).toBe(true);
  }
  for (const request of snapshot.requests) {
    expect(request.method).toBe('GET'); expect(request.path).toBe('/session/tail-gap-session/message');
    expect(request.query).toContain('directory=%2Ftail-gap-fixture');
    for (const item of request.records) expect(item.parts.some((part) => part.displayable)).toBe(true);
  }
};
const visible = (snapshot: Snapshot, ids: string[]) => {
  full(snapshot, ids);
  for (const id of ids) expect(snapshot.rows.find((row) => row.id === id)).toMatchObject({ glyphs: 1, hidden: [] });
};

// Controls run and clean up their own roots/loaders before the final failing target.
test('control: full-page equal-gap alias adoption preserves real list and scroller', async () => {
  const a = record('A'), e = record('E', 2, 'C'), c = record('C', 2);
  const s = await mount([a, e]);
  try {
    await s.settle('A'); await s.settle('E'); const before = s.observe(); visible(before, ['A', 'E']);
    s.configure([a, c]); s.hold(); await s.remove('E'); await s.stream(c); await s.settle('C');
    const painted = await s.frame('CONTROL equal-gap C before HTTP'); visible(painted, ['A', 'C']);
    await s.index('Q', 2);
    const fence = await s.frame('CONTROL equal-gap Q/H fence');
    expect(fence.positions).toEqual({ total: 2, epoch: 'Q', historyEpoch: 'H', ranges: [] });
    expect(identity(fence)).toEqual(identity(before)); visible(fence, ['A', 'C']);
    await s.release();
    for (let i = 0; i < 3; i++) {
      const state = await s.frame(`CONTROL equal-gap accepted frame ${i}`);
      expect(state.positions).toEqual({ total: 2, epoch: 'Q', historyEpoch: 'H', ranges: [{ start: 0, end: 2 }] });
      expect(identity(state)).toEqual(identity(before)); visible(state, ['A', 'C']);
    }
  } finally { await s.close(); }
}, 15000);

test('control: genuine native-history reset still replaces real list and scroller', async () => {
  const a = record('A'); const s = await mount([a]);
  try {
    await s.settle('A'); const before = s.observe(); visible(before, ['A']);
    s.configure([a], 'Q', 'J'); s.hold(); await s.index('Q', 1, 'J');
    const fence = await s.frame('CONTROL genuine history fence'); expect(identity(fence)).toEqual(identity(before));
    await s.release(); await s.settle('A');
    const after = await s.frame('CONTROL genuine history accepted'); visible(after, ['A']);
    expect(after.list).not.toBe(before.list); expect(after.scroller).not.toBe(before.scroller);
    expect(after.positions).toEqual({ total: 1, epoch: 'Q', historyEpoch: 'J', ranges: [{ start: 0, end: 1 }] });
  } finally { await s.close(); }
}, 15000);

test('control: correcting a real leading gap under the same native history replaces layout', async () => {
  const a = record('A', 2), older = record('older'); const s = await mount([a], 1, 2);
  try {
    await s.settle('A'); const before = await s.frame('CONTROL actual leading gap');
    visible(before, ['A']); expect(before.gaps).toBe(1);
    expect(before.positions).toEqual({ total: 2, epoch: 'P', historyEpoch: 'H', ranges: [{ start: 1, end: 2 }] });
    s.configure([older, a]); s.hold(); await s.index('Q', 2); await s.frame('CONTROL leading-gap fence');
    await s.release(); await s.settle('A'); await s.settle('older');
    const after = await s.frame('CONTROL leading-gap corrected'); visible(after, ['older', 'A']); expect(after.gaps).toBe(0);
    expect(after.list).not.toBe(before.list); expect(after.scroller).not.toBe(before.scroller);
  } finally { await s.close(); }
}, 15000);

test('full-parts omitted live-tail gap must not remount an already painted canonical timeline', async () => {
  const a = record('A'), e = record('E', 2, 'C'), c = record('C', 2);
  const s = await mount([a]);
  try {
    await s.settle('A'); const accepted = await s.frame('TARGET accepted P/H'); visible(accepted, ['A']);
    expect(accepted.positions).toEqual({ total: 1, epoch: 'P', historyEpoch: 'H', ranges: [{ start: 0, end: 1 }] });
    await s.stream(e); await s.settle('E'); await s.index('P', 2);
    const grown = await s.frame('TARGET P/H grows with omitted live-tail gap'); visible(grown, ['A', 'E']);
    expect(grown.positions).toEqual({ total: 2, epoch: 'P', historyEpoch: 'H', ranges: [{ start: 0, end: 1 }] });
    expect(grown.rows.find((row) => row.id === 'E')?.position).toBeUndefined();
    expect(grown.gaps).toBe(0); expect(identity(grown)).toEqual(identity(accepted));
    expect(grown.requests).toHaveLength(1);
    s.configure([a, c]); s.hold(); await s.remove('E'); await s.stream(c); await s.settle('C');
    for (let i = 0; i < 2; i++) {
      const painted = await s.frame(`TARGET canonical C painted before HTTP frame ${i}`);
      visible(painted, ['A', 'C']); expect(identity(painted)).toEqual(identity(grown)); expect(painted.gaps).toBe(0);
      expect(painted.positions).toEqual(grown.positions);
    }
    await s.index('Q', 2);
    const fenced = await s.frame('TARGET Q/H fence while canonical HTTP held'); visible(fenced, ['A', 'C']);
    expect(fenced.positions).toEqual({ total: 2, epoch: 'Q', historyEpoch: 'H', ranges: [] });
    expect(identity(fenced)).toEqual(identity(grown)); expect(fenced.gaps).toBe(0);
    expect(fenced.requests.length).toBeGreaterThan(1);
    await s.release();
    const interval = [s.observe()];
    console.log('TARGET canonical HTTP accepted commit', JSON.stringify(interval[0]));
    for (let i = 0; i < 6; i++) interval.push(await s.frame(`TARGET accepted canonical actual frame ${i}`));
    for (const state of interval) {
      full(state, ['A', 'C']); expect(state.gaps).toBe(0); expect(state.status).toBe('ready');
      expect(state.positions).toEqual({ total: 2, epoch: 'Q', historyEpoch: 'H', ranges: [{ start: 0, end: 2 }] });
    }
    await s.settle('A'); await s.settle('C'); visible(s.observe(), ['A', 'C']);
    console.log('TARGET source-only continuity result', JSON.stringify({ before: identity(grown),
      after: interval.map(identity), ancestorHiddenAtSample: interval.map((state) => state.rows.map(({ id, glyphs, hidden }) => ({ id, glyphs, hidden }))),
      actualPaintedZeroClaim: false, recordingAttributionClaim: false }));
    // First valid RED is the unneeded real list/scroller replacement, even if this synthetic DOM never paints zero.
    expect(interval.map(identity)).toEqual(interval.map(() => identity(grown)));
  } finally { await s.close(); }
}, 15000);

// Share the owning per-file environment hooks; do not re-import their cached registration in other test files.
// Real public loader/reducer/hooks/list/Legend glyph checks; synthetic frame boundaries, not served paint.
for (const marked of [true, false]) test(`body-ready native alias handoff remains one glyph (${marked ? 'marked' : 'revoked marker'})`, async () => {
  const e = record('E', 1, marked ? 'C' : undefined), c = record('C', 1);
  const metadata = marked ? { pi: { entryID: 'E' }, smartyCodeEchoOf: 'C' } : { pi: { entryID: 'E' } };
  Object.assign(e.info, { metadata });
  Object.assign(c.info, { metadata: { pi: { entryID: 'E' } } });
  const s = await mount([e]);
  const frames: ReturnType<typeof s.observe>[] = [];
  try {
    await s.settle('E'); frames.push(await s.frame('RAW body-ready'));
    s.configure([c]); s.hold();
    await s.info(c); frames.push(await s.frame('CANONICAL INFO without parts'));
    for (const part of c.parts) { await s.part(part); frames.push(await s.frame('CANONICAL full PART before raw removal')); }
    await s.remove('E'); frames.push(await s.frame('RAW removal after canonical body'));
    await s.release(); await s.settle('C'); frames.push(await s.frame('CANONICAL full HTTP acceptance'));
    console.log('ALIAS_GLYPH_FACTS', JSON.stringify({ marked, frames, nativeAndPaintNotQualified: true }));
  } finally { await s.close(); }
  expect(frames.length).toBe(5);
  expect(frames.map(f => f.rows.filter(r => r.glyphs === 1 && r.hidden.length === 0).map(r => r.id)))
    .toEqual([['E'], ['E'], ['C'], ['C'], ['C']]);
}, 15000);

// Distinct native entries are two Sends, regardless of equal text; synthetic frames, not served paint.
test('equal-text distinct entries keep two glyph rows while only one canonicalizes', async () => {
  const a = record('E1', 1), b = record('E2', 2), c = record('C1', 1);
  Object.assign(a.info, { metadata: { pi: { entryID: 'E1' }, smartyCodeEchoOf: 'C1' } });
  Object.assign(b.info, { metadata: { pi: { entryID: 'E2' } } });
  Object.assign(c.info, { metadata: { pi: { entryID: 'E1' } } });
  const s = await mount([a, b]);
  const frames: ReturnType<typeof s.observe>[] = [];
  try {
    await s.settle('E1'); await s.settle('E2'); frames.push(await s.frame('TWO distinct native entries'));
    s.configure([c, b]); s.hold();
    await s.info(c); frames.push(await s.frame('ONLY E1 has canonical INFO'));
    for (const part of c.parts) { await s.part(part); frames.push(await s.frame('ONLY E1 canonical body ready')); }
    await s.remove('E1'); frames.push(await s.frame('ONLY E1 raw removed'));
    await s.release(); await s.settle('C1'); await s.settle('E2'); frames.push(await s.frame('TWO full HTTP records'));
    console.log('DISTINCT_ALIAS_GLYPH_FACTS', JSON.stringify(frames));
  } finally { await s.close(); }
  expect(frames.map(f => f.rows.filter(r => r.glyphs === 1 && r.hidden.length === 0).map(r => r.id)))
    .toEqual([['E1', 'E2'], ['E1', 'E2'], ['C1', 'E2'], ['C1', 'E2'], ['C1', 'E2']]);
}, 15000);
