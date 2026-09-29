import { expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { showsViewOnly } from './herdrSession';

// smarty-code#811: a page left open on a session whose Pi ends kept its composer. The gateway pushes the row's new state
// (herdrState 'ended') at once; the banner must follow it without another history read.
const row = (herdrState?: string) => ({ id: 's', herdrState }) as unknown as Session;

test('the open session whose Pi ended shows View only, even though its earlier history read was not read-only', () => {
  expect(showsViewOnly(false, row('ended'))).toBe(true);
  expect(showsViewOnly(undefined, row('ended'))).toBe(true);
});

test('a live session keeps its composer; a read-only history read still shows View only', () => {
  for (const state of ['working', 'done', 'idle', undefined]) expect(showsViewOnly(false, row(state))).toBe(false);
  expect(showsViewOnly(false, null)).toBe(false);
  expect(showsViewOnly(true, row('done'))).toBe(true);
});
