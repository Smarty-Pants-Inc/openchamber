import { beforeEach, expect, test } from 'bun:test';
import type { Event } from '@opencode-ai/sdk/v2/client';
import { applyFleetSessionStatuses, applyGlobalSessionStatusEvents, getSessionStatusEventVersion, replaceGlobalSessionStatusById,
  useGlobalSessionStatusStore } from './global-session-status';

const busy = (sessionID: string) => ({ type: 'session.status', properties: { sessionID, status: { type: 'busy' } } }) as unknown as Event;
beforeEach(() => replaceGlobalSessionStatusById(new Map()));

// #126 3.11: a fleet map seeds activity for the listed sessions only, and never overwrites a newer event.
test('a fleet status map changes only the listed sessions and loses to a status event that arrived meanwhile', () => {
  applyGlobalSessionStatusEvents('/repo/a', [busy('outside')]);
  const versions = new Map([['s1', getSessionStatusEventVersion('s1')], ['s2', getSessionStatusEventVersion('s2')]]);
  applyGlobalSessionStatusEvents('/repo/a', [{ type: 'session.idle', properties: { sessionID: 's2' } } as unknown as Event]);
  applyFleetSessionStatuses([{ id: 's1', directory: '/repo/a/' }, { id: 's2', directory: '/repo/a' }],
    { s1: { type: 'busy' }, s2: { type: 'busy' } }, versions);
  const { statusById, activeSessionIds } = useGlobalSessionStatusStore.getState();
  expect([...activeSessionIds].sort()).toEqual(['outside', 's1']);
  expect(statusById.get('s1')?.directory).toBe('/repo/a');
});

test('an idle session in the fleet map clears its stale busy marker', () => {
  applyGlobalSessionStatusEvents('/repo/a', [busy('s1')]);
  applyFleetSessionStatuses([{ id: 's1', directory: '/repo/a' }], {}, new Map([['s1', getSessionStatusEventVersion('s1')]]));
  expect(useGlobalSessionStatusStore.getState().activeSessionIds.has('s1')).toBe(false);
});
