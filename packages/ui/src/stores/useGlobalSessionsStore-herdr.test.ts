import { afterEach, expect, test } from 'bun:test';
import type { Event, Session } from '@opencode-ai/sdk/v2/client';
import { useGlobalSessionsStore } from './useGlobalSessionsStore';
import { applySessionEventToGlobalSessions } from '@/sync/session-event-router';
import { readHerdrState } from '@/lib/herdrSession';
import { areSessionRenderSemanticsEqual } from '@/components/session/sidebar/sessions/sessionRenderSemantics';

// smarty-code#126 (c)5, OC#177 review: the gateway publishes a Herdr state change as session.updated, often with no
// other change. The store must publish it, so the row's state dot follows Herdr.
const session = (herdrState: string, updated = 1) => ({ id: 'ses_herdr', slug: 'ses_herdr', projectID: 'p', directory: '/repo',
  title: 'dev-lead', version: '1.0.0', time: { created: 1, updated }, herdrState } as unknown as Session);
const updated = (info: Session) => ({ type: 'session.updated', properties: { info } } as unknown as Event);
const shown = () => readHerdrState(useGlobalSessionsStore.getState().entityById.get('ses_herdr'));
afterEach(() => useGlobalSessionsStore.getState().resetForRuntimeSwitch());

test('a Herdr-only state change reaches the row, with or without a newer timestamp', () => {
  useGlobalSessionsStore.getState().applySnapshot([session('idle')], []);
  expect(shown()).toBe('idle');
  for (const state of ['blocked', 'done', 'working'] as const) {
    applySessionEventToGlobalSessions(updated(session(state)));
    expect(shown()).toBe(state);
  }
  // A state change that also advances time.updated is not a recency-only update to defer.
  applySessionEventToGlobalSessions(updated(session('idle', 2)));
  expect(shown()).toBe('idle');
});

test('a later snapshot that changes only the Herdr state replaces the row', () => {
  useGlobalSessionsStore.getState().applySnapshot([session('working')], []);
  useGlobalSessionsStore.getState().applySnapshot([session('done')], []);
  expect(shown()).toBe('done');
});

test('the row re-renders when only its Herdr state changes', () => {
  expect(areSessionRenderSemanticsEqual(session('idle'), session('idle'))).toBe(true);
  expect(areSessionRenderSemanticsEqual(session('idle'), session('blocked'))).toBe(false);
});
