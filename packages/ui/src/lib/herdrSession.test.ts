import { expect, test } from 'bun:test';
import { HERDR_STATE_DOT, isHerdrNoIdentity, readHerdrState } from './herdrSession';

test('each Herdr state reads as itself and has its own marker; stock rows have none (smarty-code#126 (c)5)', () => {
  const states = ['working', 'blocked', 'done', 'idle', 'unknown'] as const;
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
