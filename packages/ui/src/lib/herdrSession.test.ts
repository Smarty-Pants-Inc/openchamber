import { expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { HERDR_STATE_DOT, isHerdrEnded, isHerdrNoIdentity, readHerdrState } from './herdrSession';

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
