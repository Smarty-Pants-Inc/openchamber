import { describe, expect, it } from 'bun:test';
import { createFixture, deferred } from './runtime-backoff.fixtures.js';

// #3155: exercise the real trigger, template and message runtimes. These failure
// and concurrency paths are expensive to reach through an OS notification flow.
describe('notification session detail read budget', () => {
  it('reads detail once across parent, goal, template and message enrichment', async () => {
    const f = createFixture({ notifyOnSubtasks: false });
    await f.trigger(f.event('s1', '/project/a', 'stop', false));
    expect(f.details()).toHaveLength(1);
    expect(f.reads).toHaveLength(2);
    expect(f.desktop[0]).toMatchObject({ title: 'Session title', body: 'Fetched answer', kind: 'ready' });
    expect(f.details()[0].url.searchParams.get('directory')).toBe('/project/a');
    expect(f.details()[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('reserves the cooldown before any detail read, including concurrent triggers', async () => {
    const f = createFixture();
    const response = deferred();
    const started = deferred();
    f.respond(() => { started.resolve(); return response.promise; });
    const first = f.trigger();
    await started.promise;
    const duplicate = f.trigger();
    f.at(105_001);
    const lateDuplicate = f.trigger();
    // Give every trigger its settings-read continuation while detail is pending.
    await Promise.resolve();
    await Promise.resolve();
    const detailCountWhilePending = f.details().length;
    response.resolve(Response.json({ title: 'Slow session' }));
    await Promise.all([first, duplicate, lateDuplicate]);
    expect(detailCountWhilePending).toBe(1);
    expect(f.details()).toHaveLength(1);
    expect(f.push).toHaveLength(1);
    expect(f.desktop[0].title).toBe('Slow session');
  });

  it('does not let one slow session block another session or directory', async () => {
    const f = createFixture();
    const response = deferred();
    const started = deferred();
    f.respond(async (url) => {
      if (url.pathname === '/session/s1' && url.searchParams.get('directory') === '/project/a') {
        started.resolve();
        return response.promise;
      }
      return Response.json({ title: 'Independent' });
    });
    const slow = f.trigger();
    await started.promise;
    await Promise.all([f.trigger(f.event('s2')), f.trigger(f.event('s1', '/project/b'))]);
    const independentPushes = f.push.length;
    response.resolve(Response.json({ title: 'Slow' }));
    await slow;
    expect(independentPushes).toBe(2);
    expect(f.push).toHaveLength(3);
    expect(f.details()).toHaveLength(3);
  });

  it('checks the 5 second cooldown before fetching and reopens at the exact boundary', async () => {
    const f = createFixture();
    await f.trigger();
    f.at(104_999);
    await f.trigger();
    expect(f.details()).toHaveLength(1);
    expect(f.push).toHaveLength(1);
    f.at(105_000);
    await f.trigger();
    expect(f.details()).toHaveLength(2);
    expect(f.push).toHaveLength(2);
  });

  for (const status of [404, 409, 410]) {
    it(`backs off ${status} for 60 seconds from failure, then recovers exactly at expiry`, async () => {
      const f = createFixture();
      const response = deferred();
      const started = deferred();
      f.respond(() => { started.resolve(); return response.promise; });
      const first = f.trigger();
      await started.promise;
      f.at(102_000);
      response.resolve(new Response(null, { status }));
      await first;
      expect(f.details()).toHaveLength(1);
      expect(f.push[0].data.type).toBe('ready');
      expect(f.push[0].data.sessionName).toBe('');
      for (const time of [107_000, 157_000]) {
        f.at(time);
        await f.trigger();
        await f.trigger(f.event('s1', '/project/a', 'error'));
        await f.runtime.sendGoalSettlePush({ sessionId: 's1', directory: '/project/a', status: 'complete', title: 'Done', body: 'Goal' });
      }
      f.at(161_999);
      await f.runtime.sendGoalSettlePush({ sessionId: 's1', directory: '/project/a', status: 'complete', title: 'Done', body: 'Goal' });
      expect(f.details()).toHaveLength(1);
      f.respond(async () => Response.json({ title: 'Recovered', metadata: { openchamber: { goal: { status: 'active' } } } }));
      f.at(162_000);
      const beforeRecovery = f.push.length;
      await f.trigger();
      expect(f.push).toHaveLength(beforeRecovery);
      await f.runtime.sendGoalSettlePush({ sessionId: 's1', directory: '/project/a', status: 'complete', title: 'Done', body: 'Goal' });
      expect(f.details()).toHaveLength(2);
      expect(f.push.at(-1).data.sessionName).toBe('Recovered');
      const before = f.push.length;
      f.at(167_000);
      await f.trigger();
      expect(f.push).toHaveLength(before);
      expect(f.details()).toHaveLength(3);
    });
  }

  for (const failure of ['503', 'network', 'malformed']) {
    it(`can recover from a nonterminal ${failure} failure after 5 seconds`, async () => {
      const f = createFixture();
      f.respond(async () => {
        if (failure === 'network') throw new Error('offline');
        return failure === 'malformed' ? new Response('{') : new Response(null, { status: 503 });
      });
      await f.trigger();
      expect(f.details()).toHaveLength(1);
      expect(f.push[0].data.sessionName).toBe('');
      f.respond(async () => Response.json({ title: 'Recovered' }));
      f.at(105_000);
      await f.trigger();
      expect(f.details()).toHaveLength(2);
      expect(f.desktop.at(-1).title).toBe('Recovered');
    });
  }

  it('isolates both cooldown and terminal failure by session and directory', async () => {
    const f = createFixture();
    f.respond(async (url) => url.searchParams.get('directory') === '/project/a' && url.pathname === '/session/s1'
      ? new Response(null, { status: 404 })
      : Response.json({ title: `${url.pathname}:${url.searchParams.get('directory')}` }));
    await f.trigger();
    await f.trigger(f.event('s2'));
    await f.trigger(f.event('s1', '/project/b'));
    expect(f.details()).toHaveLength(3);
    expect(f.desktop.map(({ title }) => title)).toEqual(['Agent agent is ready', '/session/s2:/project/a', '/session/s1:/project/b']);
    f.at(105_000);
    await f.trigger();
    expect(f.details()).toHaveLength(3);
  });
});
