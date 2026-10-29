import { describe, expect, it } from 'bun:test';
import { createFixture, deferred } from './runtime-backoff.fixtures.js';

const messages = (f) => f.reads.filter(({ url }) => url.pathname.endsWith('/message'));
const recoveredMessage = () => Response.json([{
  info: { id: 'm1', role: 'assistant', finish: 'stop' },
  parts: [{ type: 'text', text: '**Recovered answer**' }],
}]);

describe('notification terminal message reads', () => {
  for (const detailStatus of [200, 404]) {
    for (const messageStatus of [404, 409, 410]) {
      it(`backs off message ${messageStatus} independently of detail ${detailStatus}`, async () => {
        const f = createFixture();
        f.respond(async () => detailStatus === 200 ? Response.json({ title: 'Known session' }) : new Response(null, { status: detailStatus }));
        f.respondMessage(async () => new Response(null, { status: messageStatus }));
        const idle = { type: 'session.idle', properties: { sessionID: 's1', directory: '/project/a' } };
        await f.trigger(idle);
        expect(f.details()).toHaveLength(1);
        expect(messages(f)).toHaveLength(1);
        expect(f.desktop[0]).toMatchObject({ kind: 'ready', body: 'Assistant completed the task' });
        for (const time of [105_000, 155_000]) {
          f.at(time);
          await f.trigger(idle);
          await f.trigger(f.event('s1', '/project/a', 'error', false));
        }
        f.at(159_999);
        await f.trigger(f.event('s1', '/project/a', 'error', false));
        expect(messages(f)).toHaveLength(1);
        expect(f.push.filter(({ data }) => data.type === 'ready')).toHaveLength(3);
        expect(f.push.filter(({ data }) => data.type === 'error')).toHaveLength(2);
        f.respondMessage(async () => recoveredMessage());
        f.at(160_000);
        await f.trigger(idle);
        expect(messages(f)).toHaveLength(2);
        expect(f.desktop.at(-1).body).toBe('Recovered answer');
      });
    }
  }

  it('starts the message backoff when the terminal response arrives, not when requested', async () => {
    const f = createFixture();
    const response = deferred();
    const started = deferred();
    f.respondMessage(() => { started.resolve(); return response.promise; });
    const first = f.trigger(f.event('s1', '/project/a', 'stop', false));
    await started.promise;
    f.at(102_000);
    response.resolve(new Response(null, { status: 404 }));
    await first;
    f.respondMessage(async () => recoveredMessage());
    f.at(161_999);
    await f.trigger(f.event('s1', '/project/a', 'error', false));
    expect(messages(f)).toHaveLength(1);
    f.at(162_000);
    await f.trigger(f.event('s1', '/project/a', 'stop', false));
    expect(messages(f)).toHaveLength(2);
    expect(f.desktop.at(-1).body).toBe('Recovered answer');
  });

  it('still uses a readable message when detail failed', async () => {
    const f = createFixture();
    f.respond(async () => new Response(null, { status: 404 }));
    await f.trigger(f.event('s1', '/project/a', 'stop', false));
    expect(messages(f)).toHaveLength(1);
    expect(f.desktop[0].body).toBe('Fetched answer');
  });

  it('does not cache successful message text across separate triggers', async () => {
    const f = createFixture();
    await f.trigger(f.event('s1', '/project/a', 'stop', false));
    f.respondMessage(async () => recoveredMessage());
    await f.trigger(f.event('s1', '/project/a', 'error', false));
    expect(messages(f)).toHaveLength(2);
    expect(f.desktop.map(({ body }) => body)).toEqual(['Fetched answer', 'Recovered answer']);
  });

  it('isolates terminal message backoff by directory and session', async () => {
    const f = createFixture();
    f.respondMessage(async (url) => url.pathname === '/session/s1/message' && url.searchParams.get('directory') === '/project/a'
      ? new Response(null, { status: 410 }) : recoveredMessage());
    await f.trigger(f.event('s1', '/project/a', 'stop', false));
    await f.trigger(f.event('s2', '/project/a', 'stop', false));
    await f.trigger(f.event('s1', '/project/b', 'stop', false));
    expect(messages(f)).toHaveLength(3);
    expect(f.desktop.map(({ body }) => body)).toEqual(['Assistant completed the task', 'Recovered answer', 'Recovered answer']);
    f.at(105_000);
    await f.trigger(f.event('s1', '/project/a', 'stop', false));
    expect(messages(f)).toHaveLength(3);
  });

  for (const failure of ['503', 'network', 'malformed']) {
    it(`allows recovery after a nonterminal message ${failure}`, async () => {
      const f = createFixture();
      f.respondMessage(async () => {
        if (failure === 'network') throw new Error('offline');
        return failure === 'malformed' ? new Response('{') : new Response(null, { status: 503 });
      });
      await f.trigger(f.event('s1', '/project/a', 'stop', false));
      f.respondMessage(async () => recoveredMessage());
      f.at(105_000);
      await f.trigger(f.event('s1', '/project/a', 'stop', false));
      expect(messages(f)).toHaveLength(2);
      expect(f.desktop.at(-1).body).toBe('Recovered answer');
    });
  }

  it('shares a slow message list but resolves each trigger message id separately', async () => {
    const f = createFixture();
    const response = deferred();
    const started = deferred();
    f.respondMessage(() => { started.resolve(); return response.promise; });
    const first = f.trigger(f.event('s1', '/project/a', 'stop', false));
    await started.promise;
    f.at(105_001);
    const error = f.event('s1', '/project/a', 'error', false);
    error.properties.info.id = 'm2';
    const second = f.trigger(error);
    // The error trigger can finish detail/template enrichment while the tail is held.
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
    const pendingMessageReads = messages(f).length;
    response.resolve(Response.json([
      { info: { id: 'm1', role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Ready answer' }] },
      { info: { id: 'm2', role: 'assistant', finish: 'error' }, parts: [{ type: 'text', text: 'Error answer' }] },
    ]));
    await Promise.all([first, second]);
    expect(pendingMessageReads).toBe(1);
    expect(messages(f)).toHaveLength(1);
    expect(f.desktop.map(({ body }) => body).sort()).toEqual(['Error answer', 'Ready answer']);
  });
});
