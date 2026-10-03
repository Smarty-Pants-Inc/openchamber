import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import type { Event } from '@opencode-ai/sdk/v2/client';
import { applyGlobalSessionStatusEvents, useGlobalSessionStatusStore } from '../sync/global-session-status';
import { HERDR_STATE_DOT, rowNativeStatus, herdrSignature, liveHerdrState, herdrSuccessorOf, isHerdrEnded, isHerdrNoIdentity, readHerdrState, successorTarget } from './herdrSession';

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

// #1140 (code-lead 02:32Z): done takes whichever comes first, Herdr's done or native idle; Working follows native busy;
// the marker never bounces back. Native input is the status store's entry: native idle is NO entry (the store deletes a
// settled session), so the steps say undefined where native is idle, as the row receives it (openchamber#484 round 2).
describe('#1140: change order', () => {
  const row = (id: string, h: ReturnType<typeof readHerdrState>, n: string | undefined) => {
    const r = rowNativeStatus(id, h, n); return liveHerdrState(h, r.native, r.herdrIsNewer);
  };
  const run = (id: string, steps: Array<[ReturnType<typeof readHerdrState>, string | undefined]>) => steps.map(([h, n]) => row(id, h, n));
  test('a whole turn: Working at native busy, done at Herdr\'s earlier done, no bounce while native is still busy', () => {
    expect(run('turn-1', [['done', undefined], ['done', 'busy'], ['working', 'busy'], ['done', 'busy'], ['done', 'busy'], ['done', undefined]]))
      .toEqual(['done', 'working', 'working', 'done', 'done', 'done']);
  });
  test('a new turn after a stale done: native busy is newer, so Working (not the stale done)', () => {
    expect(run('turn-2', [['done', undefined], ['done', 'busy']])).toEqual(['done', 'working']);
  });
  test('native idle first (Herdr still working): done, and it stays done when Herdr follows', () => {
    expect(run('turn-3', [['working', 'busy'], ['working', undefined], ['done', undefined]])).toEqual(['working', 'done', 'done']);
  });
  test('the same values again (a re-render) do not reorder: still done', () => {
    expect(run('turn-4', [['working', 'busy'], ['done', 'busy'], ['done', 'busy'], ['done', 'busy']])).toEqual(['working', 'done', 'done', 'done']);
  });
  test('a row first seen mid-window (Herdr done, native busy) has no order: native wins until it changes', () => {
    expect(run('turn-5', [['done', 'busy'], ['done', undefined]])).toEqual(['working', 'done']);
  });
  test('no native status ever (a Herdr-only row): Herdr is the fallback, Working stays Working', () => {
    expect(run('turn-6', [['working', undefined], ['working', undefined], ['done', undefined]])).toEqual(['working', 'working', 'done']);
  });
  test('after a known idle, a new turn Herdr samples first stays Working until native busy and idle follow', () => {
    expect(run('turn-7', [['working', 'busy'], ['working', undefined], ['idle', undefined], ['working', undefined], ['working', 'busy'], ['working', undefined]]))
      .toEqual(['working', 'done', 'idle', 'working', 'working', 'done']);
  });
  // Round 2: through the real reducer and the store selector the row subscribes to (useGlobalSessionStatus reads
  // statusById.get(id)?.status), with Herdr's sample held at working the whole time.
  test('busy -> idle through the global-status reducer clears Working while Herdr still says working', () => {
    const id = 'reducer-1140', entry = () => useGlobalSessionStatusStore.getState().statusById.get(id)?.status.type;
    const status = (type: string) => applyGlobalSessionStatusEvents('/repo', [{ type: 'session.status', properties: { sessionID: id, status: { type } } } as Event]);
    expect(row(id, 'working', entry())).toBe('working'); // first seen: no native status yet, Herdr's working
    status('busy'); expect(entry()).toBe('busy'); expect(row(id, 'working', entry())).toBe('working');
    status('idle'); expect(entry()).toBeUndefined(); expect(row(id, 'working', entry())).toBe('done');
    expect(row(id, 'working', entry())).toBe('done'); // a re-render with the same stale sample stays done
  });
  // A rapid successor arrives before native idle settles, while Herdr still has the previous turn's sample.
  for (const stale of ['done', 'idle'] as const) for (const changed of ['presentationId', 'generation'] as const) {
    test(`busy successor with changed ${changed} overrides stale Herdr ${stale} without an idle entry`, () => {
      const id = `successor-${stale}-${changed}`;
      let herdr: 'working' | 'done' | 'idle' = 'working';
      let marker: ReturnType<typeof liveHerdrState>;
      const render = () => {
        const entry = useGlobalSessionStatusStore.getState().statusById.get(id)?.status;
        const r = rowNativeStatus(id, herdr, entry?.type, false, entry?.ordinaryTarget);
        marker = liveHerdrState(herdr, r.native, r.herdrIsNewer);
      };
      const publish = (presentationId: string, generation = 'g1', dialog = false) => {
        const status = { type: 'busy' as const, ordinary: true, ordinaryTarget: { generation, presentationId },
          ordinaryDialog: dialog ? { kind: 'confirm' as const } : null };
        const event: Event = { id: `${id}-${presentationId}-${generation}-${dialog}`, type: 'session.status', properties: { sessionID: id, status } };
        applyGlobalSessionStatusEvents('/repo', [event]);
      };
      // The row's leaf subscription: a changed status object renders even when its type is still busy.
      const unsubscribe = useGlobalSessionStatusStore.subscribe((state, previous) => {
        if (state.statusById.get(id)?.status !== previous.statusById.get(id)?.status) render();
      });
      try {
        publish('run-a'); expect(marker).toBe('working');
        herdr = stale; render(); expect(marker).toBe(stale);
        publish('run-a', 'g1', true); expect(marker).toBe(stale); // same turn, new status object: no bounce
        publish('run-a', 'g1', true); render(); expect(marker).toBe(stale); // identical poll and re-render
        publish(changed === 'presentationId' ? 'run-b' : 'run-a', changed === 'generation' ? 'g2' : 'g1');
        expect(useGlobalSessionStatusStore.getState().statusById.get(id)?.status.type).toBe('busy');
        expect(marker).toBe('working');
        render(); expect(marker).toBe('working');
        herdr = 'working'; render(); expect(marker).toBe('working');
        herdr = 'done'; render(); expect(marker).toBe('done'); // the successor's own Done still wins
      } finally { unsubscribe(); }
    });
  }
  // Round 3: a collapsed group unmounts its rows, so the row sees none of the changes made meanwhile.
  test('unmounted while native goes idle -> busy and Herdr samples done: the remount shows Working (native wins)', () => {
    const id = 'remount-1140', entry = () => useGlobalSessionStatusStore.getState().statusById.get(id)?.status.type;
    const status = (type: string) => applyGlobalSessionStatusEvents('/repo', [{ type: 'session.status', properties: { sessionID: id, status: { type } } } as Event]);
    const mounted = (h: ReturnType<typeof readHerdrState>, first = false) => {
      const r = rowNativeStatus(id, h, entry(), first); return liveHerdrState(h, r.native, r.herdrIsNewer);
    };
    status('busy'); expect(mounted('working', true)).toBe('working'); expect(mounted('working')).toBe('working');
    status('idle'); status('busy'); // the group is collapsed: the turn ends and a new one starts, no row renders
    expect(entry()).toBe('busy');
    expect(mounted('done', true)).toBe('working'); // expanded before Herdr samples the new turn's working
    expect(mounted('done')).toBe('working'); // and a re-render keeps it
    expect(mounted('working')).toBe('working');
  });
  test('a remount after the turn ended while unmounted (native idle, Herdr done) shows done', () => {
    const id = 'remount-idle-1140', entry = () => useGlobalSessionStatusStore.getState().statusById.get(id)?.status.type;
    const status = (type: string) => applyGlobalSessionStatusEvents('/repo', [{ type: 'session.status', properties: { sessionID: id, status: { type } } } as Event]);
    status('busy'); expect(liveHerdrState('working', rowNativeStatus(id, 'working', entry(), true).native)).toBe('working');
    status('idle');
    const r = rowNativeStatus(id, 'done', entry(), true);
    expect(r.native).toBe('idle'); expect(liveHerdrState('done', r.native, r.herdrIsNewer)).toBe('done');
    const r2 = rowNativeStatus(id, 'working', entry(), true); // even a stale Herdr working: known idle wins on remount
    expect(liveHerdrState('working', r2.native, r2.herdrIsNewer)).toBe('done');
  });
});
