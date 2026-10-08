import { describe, expect, test } from 'bun:test';
import type { Event } from '@opencode-ai/sdk/v2/client';
import { liveHerdrState, rowNativeStatus, type HerdrState } from './herdrSession';
import { applyGlobalSessionStatusEvents, useGlobalSessionStatusStore } from '../sync/global-session-status';

// smarty-code#1234: the row's Working is ordered by recency between Herdr's state and the native status. A native idle
// the row cannot see as a status-entry change (the store keeps no idle entry, so an idle with no busy before it, or one
// that ended while the row was unmounted, changes nothing the row reads) must still clear an older Herdr Working.
const entry = (id: string) => useGlobalSessionStatusStore.getState().statusById.get(id)?.status.type;
const nativeAt = (id: string) => useGlobalSessionStatusStore.getState().nativeAtById.get(id);
// SAFETY: a session.idle event carries only the addressed session ID, which is all the reducer reads.
const nativeIdle = (id: string) => applyGlobalSessionStatusEvents('/repo', [{ type: 'session.idle', properties: { sessionID: id } } as Event]);
const view = (id: string, herdr: HerdrState, remounted = false) => {
  const r = rowNativeStatus(id, herdr, entry(id), nativeAt(id), remounted);
  return liveHerdrState(herdr, r.native, r.herdrIsNewer);
};

describe('#1234: Herdr Working against the native idle, by recency', () => {
  test('(1) Herdr working at t1, native idle at t2 > t1: the row is not Working (done)', () => {
    const id = 'recency-1';
    expect(view(id, 'idle')).toBe('idle');
    expect(view(id, 'working')).toBe('working'); // t1: Herdr says working
    nativeIdle(id); // t2: the native session went idle
    expect(view(id, 'working')).toBe('done'); // the re-render with Herdr's stale working
    expect(view(id, 'working')).toBe('done');
  });
  test('(1b) the native idle came while the row was unmounted: the remount is not Working', () => {
    const id = 'recency-1b';
    expect(view(id, 'idle', true)).toBe('idle');
    expect(view(id, 'working')).toBe('working');
    nativeIdle(id); // collapsed group: no render
    expect(view(id, 'working', true)).toBe('done');
  });
  test('(2) native idle at t1, Herdr working at t2 > t1: the row is Working', () => {
    const id = 'recency-2';
    nativeIdle(id); // t1
    expect(view(id, 'idle')).toBe('idle');
    expect(view(id, 'working')).toBe('working'); // t2: Herdr saw a run the native status did not (a non-native run)
    expect(view(id, 'working')).toBe('working'); // a re-render does not reorder
  });
  test('(3) no native status: Herdr decides, as today', () => {
    const id = 'recency-3';
    expect(view(id, 'working')).toBe('working');
    expect(view(id, 'working')).toBe('working');
    expect(view(id, 'done')).toBe('done');
    expect(view(id, 'blocked')).toBe('blocked');
  });
});
