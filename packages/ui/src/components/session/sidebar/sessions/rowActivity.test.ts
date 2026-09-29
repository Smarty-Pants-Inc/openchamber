import { expect, test } from 'bun:test';
import { rowActivity } from './rowActivity';
import { sidebarHerdrI18n } from '@/lib/i18n/messages/sidebar-herdr.i18n';
import { statusUnavailableI18n } from '@/lib/i18n/messages/status-unavailable.i18n';

const base = { isStreaming: true, needsAttention: true, isActive: false, isMovingToWorktree: false, hasActivityDuration: true };

test('a Herdr row shows only its Herdr state: no timer, no unread marker (smarty-code#126 F4)', () => {
  for (const herdrState of ['working', 'blocked', 'done', 'idle', 'unknown'] as const) {
    expect(rowActivity({ ...base, herdrState })).toEqual({ showUnreadStatus: false, showStatusUnavailable: false, showStatusMarker: true, showActivityDuration: false });
    expect(rowActivity({ ...base, isStreaming: false, herdrState })).toEqual({ showUnreadStatus: false, showStatusUnavailable: false, showStatusMarker: true, showActivityDuration: false });
  }
});

test('a stock row keeps its running marker and timer, and its unread marker', () => {
  expect(rowActivity({ ...base, herdrState: undefined })).toEqual({ showUnreadStatus: false, showStatusUnavailable: false, showStatusMarker: true, showActivityDuration: true });
  expect(rowActivity({ ...base, isStreaming: false, herdrState: undefined })).toEqual({ showUnreadStatus: true, showStatusUnavailable: false, showStatusMarker: true, showActivityDuration: true });
  expect(rowActivity({ ...base, isStreaming: false, needsAttention: false, herdrState: undefined }).showStatusMarker).toBe(false);
});

test("the state labels are Herdr's own words (working, blocked, done, idle), as the as-loaded gate reads them", () => {
  const en = sidebarHerdrI18n.en;
  for (const state of ['working', 'blocked', 'done', 'idle'] as const) {
    expect(en[`sessions.sidebar.herdr.state.${state}`].toLowerCase()).toBe(state);
  }
});

// smarty-code#539: a project whose status the gateway could not read says so, unless Herdr shows the row's state.
test('a row without a Herdr state whose status is unknown shows only "Status unavailable"', () => {
  for (const isStreaming of [true, false]) {
    expect(rowActivity({ ...base, isStreaming, herdrState: undefined, statusUnavailable: true }))
      .toEqual({ showUnreadStatus: false, showStatusUnavailable: true, showStatusMarker: true, showActivityDuration: false });
  }
  expect(statusUnavailableI18n.en['sessions.sidebar.session.status.unavailable']).toBe('Status unavailable');
});

test("an unknown status never covers Herdr's own state", () => {
  for (const herdrState of ['working', 'blocked', 'done', 'idle', 'unknown'] as const) {
    expect(rowActivity({ ...base, herdrState, statusUnavailable: true }).showStatusUnavailable).toBe(false);
  }
});
