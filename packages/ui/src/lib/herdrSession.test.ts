import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { HERDR_STATE_DOT, herdrSignature, liveHerdrState, herdrSuccessorOf, isHerdrEnded, isHerdrNoIdentity, readHerdrState, successorTarget } from './herdrSession';

test('each Herdr state reads as itself and has its own marker; stock rows have none (smarty-code#126 (c)5)', () => {
  const states = ['working', 'blocked', 'done', 'idle', 'unknown', 'ended'] as const;
  for (const state of states) expect(readHerdrState({ herdrState: state })).toBe(state);
  expect(new Set(states.map((state) => HERDR_STATE_DOT[state])).size).toBe(states.length);
  expect(readHerdrState({ herdrState: 'hibernating' })).toBe('unknown');
  expect(readHerdrState({ id: 'stock' })).toBeUndefined();
  expect(readHerdrState(undefined)).toBeUndefined();
});

test('only a row the gateway marks has no session identity (smarty-code#126 (c)3)', () => {
  expect(isHerdrNoIdentity({ herdrNoIdentity: true })).toBe(true);
  expect(isHerdrNoIdentity({ herdrNoIdentity: 'true' })).toBe(false);
  expect(isHerdrNoIdentity({})).toBe(false);
  expect(isHerdrNoIdentity(null)).toBe(false);
});

test('a Code-created session whose Pi ended reads as ended (listed read-only from its transcript)', () => {
  // SAFETY: a stock session object plus the gateway's herdrState field; only the fields read here matter.
  const row = (herdrState: string | undefined) => Object.assign({ id: 'ses', slug: 'ses', projectID: 'p', directory: '/p', title: 't',
    version: '1', time: { created: 1, updated: 1 } }, herdrState === undefined ? {} : { herdrState }) as Session;
  expect(isHerdrEnded(row('ended'))).toBe(true);
  expect(isHerdrEnded(row('done'))).toBe(false);
  expect(isHerdrEnded(row(undefined))).toBe(false);
});

test('a re-keyed Herdr row names its successor; the viewed row follows it once (smarty-code#863)', () => {
  expect(herdrSuccessorOf({ herdrSuccessor: 'ses-new' })).toBe('ses-new');
  expect(herdrSuccessorOf({ herdrSuccessor: '' })).toBeUndefined();
  expect(herdrSuccessorOf({ herdrSuccessor: 1 })).toBeUndefined();
  expect(herdrSuccessorOf(null)).toBeUndefined();
  // The mark alone is a change the row must see.
  expect(herdrSignature({ herdrNoIdentity: true })).not.toBe(herdrSignature({ herdrNoIdentity: true, herdrSuccessor: 'ses-new' }));

  const old = { id: 'herdr-pane-p1', herdrNoIdentity: true, herdrSuccessor: 'ses-new' };
  const other = { id: 'ses-other' };
  expect(successorTarget('herdr-pane-p1', [other, old])).toBe('ses-new');
  expect(successorTarget('ses-other', [other, old])).toBeUndefined();
  expect(successorTarget(null, [old])).toBeUndefined();
  expect(successorTarget('ses-new', [{ id: 'ses-new', herdrSuccessor: 'ses-new' }])).toBeUndefined();
});

test('a reloading fleet Pi is recognized and changes the row signature (smarty-code#870)', async () => {
  const { isOrdinaryReloading, herdrSignature } = await import('./herdrSession');
  expect(isOrdinaryReloading({ ordinaryReloading: true })).toBe(true);
  expect(isOrdinaryReloading({})).toBe(false);
  expect(herdrSignature({ ordinaryReloading: true })).not.toBe(herdrSignature({}));
});

// smarty-code#1140: the row's running marker follows Herdr's sample (the gateway re-reads it every 2 s, 17-59 s under
// load), while the page already has the session's native busy/idle status. Native status wins for running; Herdr keeps
// what only it knows (blocked, ended) and is the fallback where there is no native status.
describe('#1140: liveHerdrState', () => {
  test('a native busy status while the Herdr sample is still stale (idle, done, unknown) shows working', () => {
    for (const stale of ['idle', 'done', 'unknown'] as const) {
      expect(liveHerdrState(stale, 'busy')).toBe('working');
      expect(liveHerdrState(stale, 'retry')).toBe('working');
    }
  });
  test('a native idle status while the Herdr sample still says working shows done', () => {
    expect(liveHerdrState('working', 'idle')).toBe('done');
  });
  test('without a native status, Herdr is the fallback, unchanged', () => {
    for (const s of ['working', 'blocked', 'done', 'idle', 'unknown', 'ended'] as const) expect(liveHerdrState(s, undefined)).toBe(s);
  });
  test('blocked and ended stay Herdr\'s; a stock row (no Herdr state) stays undefined', () => {
    expect(liveHerdrState('blocked', 'busy')).toBe('blocked');
    expect(liveHerdrState('ended', 'busy')).toBe('ended');
    expect(liveHerdrState(undefined, 'busy')).toBe(undefined);
  });
  test('agreeing states are unchanged', () => {
    expect(liveHerdrState('working', 'busy')).toBe('working');
    expect(liveHerdrState('done', 'idle')).toBe('done');
    expect(liveHerdrState('idle', 'idle')).toBe('idle');
  });
});
