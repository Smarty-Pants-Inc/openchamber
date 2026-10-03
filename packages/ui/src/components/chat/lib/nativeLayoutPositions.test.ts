import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { snapshotNativeLayout, withNativeLayoutPositions } from './nativeLayoutPositions';
import { optimisticMessageRecords } from '@/sync/unsaved';
import type { ChatMessageEntry } from './turns/types';

// Layout-only source controls, adopted from the repaired helper probe; no native authority or paint claim.
test('native layout fallback rejects ambiguous/foreign/malformed identities and remains bounded', () => {
  const row = (id: string, entryID = id, sessionID = 'S', echo?: string): ChatMessageEntry => ({
    info: Object.assign({ id, sessionID, role: 'user' as const, time: { created: 1 }, agent: 'build',
      model: { providerID: 'test', modelID: 'test' } },
    { metadata: { pi: { entryID }, smartyCodeEchoOf: echo } }), parts: [],
  });
  const e = row('E', 'E', 'S', 'C'), c = row('C', 'E');
  const at = (id: string) => id === 'E' ? 3 : undefined;
  const snapshot = snapshotNativeLayout([e], at);
  const check = (name: string, rows: ChatMessageEntry[], expected: number | undefined,
    source: (id: string) => number | undefined = at, saved = snapshot) => {
    assert.equal(withNativeLayoutPositions(rows, source, saved)?.('C'), expected, name);
  };
  check('current raw coordinate, no committed snapshot', [e, c], 3, at, []);
  check('raw removal uses bounded committed coordinate', [c], 3, () => undefined);
  check('reflected canonical position wins', [c], 8, id => id === 'C' ? 8 : undefined);
  check('same-session revoked echo marker is layout identity', [row('E'), c], 3, at, []);
  check('foreign canonical session', [row('C', 'E', 'foreign')], undefined);
  check('foreign current raw overrides old snapshot', [row('E', 'E', 'foreign'), c], undefined);
  check('competing aliases', [c, row('D', 'E')], undefined);
  check('competing alias with conflicting echo', [c, row('D', 'E', 'S', 'foreign')], undefined);
  check('duplicate public alias identity', [c, row('C', 'E')], undefined);
  check('public alias belongs to another native entry', [c, row('C', 'C')], undefined);
  check('raw conflicts with canonical public target', [row('E', 'E', 'S', 'D'), c], undefined);
  check('canonical echo is not native layout evidence', [row('C', 'E', 'S', 'other')], undefined);
  check('text alone supplies no identity', [{ ...c, info: Object.assign({}, c.info, { metadata: undefined }) }], undefined);
  for (const value of ['', ' ', 'x'.repeat(257), 42, null, ['E'], { id: 'E' }]) {
    check(`malformed canonical entry ${JSON.stringify(value)}`, [{ ...c,
      info: Object.assign({}, c.info, { metadata: { pi: { entryID: value } } }) }], undefined);
    check(`malformed current raw ${JSON.stringify(value)} supersedes snapshot`, [{ ...e,
      info: Object.assign({}, e.info, { metadata: { pi: { entryID: value } } }) }, c], undefined);
  }
  optimisticMessageRecords.add(c.info);
  try { check('optimistic canonical is not layout evidence', [c], undefined); }
  finally { optimisticMessageRecords.delete(c.info); }
  check('voice-start canonical is not layout evidence', [{ ...c, info: Object.assign({}, c.info,
    { metadata: { pi: { entryID: 'E' }, smartyVoice: { start: true } } }) }], undefined);
  const bounded = snapshotNativeLayout(Array.from({ length: 3000 }, (_, i) => row(`E${i}`)), () => 3);
  assert.equal(bounded.length, 2048);
  assert.equal(snapshotNativeLayout([e], () => -1).length, 0);
  check('coherent layout reset leaves no stale fallback', [c], undefined, () => undefined, []);
});
