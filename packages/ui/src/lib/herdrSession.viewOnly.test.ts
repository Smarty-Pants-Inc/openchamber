import { expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { herdrSignature, showsViewOnly } from './herdrSession';

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

// smarty-code#957 (#790 run 2, 3.53): a Code-made session whose Pi stopped or lost Code's bridge in an open pane has its
// history served read-only, and showed the FLEET banner ("started in Herdr") in place of its composer. The gateway marks
// such a row ordinaryCodeMade: it keeps its composer (Send off, with its reason; the typed line kept). Ended stays View only.
test('an unavailable Code-made session keeps its composer; a fleet session and an ended one still show View only', () => {
  const made = (herdrState?: string) => ({ id: 's', herdrState, ordinaryCodeMade: true }) as unknown as Session;
  expect(showsViewOnly(true, made('idle'))).toBe(false);
  expect(showsViewOnly(true, made(undefined))).toBe(false);
  expect(showsViewOnly(true, made('ended'))).toBe(true);
  expect(showsViewOnly(true, row('idle'))).toBe(true); // A fleet session: unchanged.
  expect(herdrSignature(made('idle'))).not.toBe(herdrSignature(row('idle'))); // The flag alone reaches the row.
});

// openchamber#411 round 1 (smarty-code#957): the composer also SAYS why Send is off and how to reconnect, in every locale;
// only for a Code-made session that is not ended (a fleet session and an ended one have their own words).
test('a Code-made unavailable session says its Pi lost Code and how to reconnect; fleet and ended rows do not', async () => {
  const { isPiDisconnected } = await import('./herdrSession');
  const made = (herdrState?: string) => ({ id: 's', herdrState, ordinaryCodeMade: true }) as unknown as Session;
  expect(isPiDisconnected(made('done'))).toBe(true);
  expect(isPiDisconnected(made('ended'))).toBe(false);
  expect(isPiDisconnected(row('idle'))).toBe(false);
  const { sidebarHerdrI18n } = await import('./i18n/messages/sidebar-herdr.i18n');
  for (const [locale, messages] of Object.entries(sidebarHerdrI18n)) {
    expect([locale, typeof messages['sessions.sidebar.herdr.disconnected']]).toEqual([locale, 'string']);
    expect(messages['sessions.sidebar.herdr.disconnected'].length).toBeGreaterThan(20);
  }
  expect(/lost its connection to Code.*Quit Pi.*start it again/.test(sidebarHerdrI18n.en['sessions.sidebar.herdr.disconnected'])).toBe(true);
});
