import { describe, expect, it } from 'bun:test';
import { createFixture } from './runtime-backoff.fixtures.js';

describe('notification behavior with shared session detail', () => {
  it('retains separate ready/error fanout, formatting and APNs privacy', async () => {
    const f = createFixture();
    await f.trigger({ type: 'session.idle', properties: { sessionID: 's1' } }, '/project/a');
    await f.trigger({ type: 'session.error', properties: { sessionID: 's1', error: { message: '**Failure**' } } }, '/project/a');
    expect(f.desktop.map(({ kind, body, directory }) => ({ kind, body, directory }))).toEqual([
      { kind: 'ready', body: 'Fetched answer', directory: '/project/a' },
      { kind: 'error', body: 'Failure', directory: '/project/a' },
    ]);
    expect(f.push.map(({ data }) => data.type)).toEqual(['ready', 'error']);
    expect(f.apns[1]).toMatchObject({ title: 'Agent hit an error', body: 'Session title', badge: 2, data: { sessionId: 's1' } });
    expect(f.details()).toHaveLength(1);
  });

  it('suppresses active-goal turns, then resumes when the goal settles', async () => {
    const f = createFixture();
    f.respond(async () => Response.json({ title: 'Goal session', metadata: { openchamber: { goal: { status: 'active' } } } }));
    await f.trigger();
    expect(f.push).toHaveLength(0);
    f.respond(async () => Response.json({ title: 'Goal session', metadata: { openchamber: { goal: { status: 'complete' } } } }));
    f.at(105_000);
    await f.trigger();
    expect(f.push).toHaveLength(1);
    expect(f.desktop[0].title).toBe('Goal session');
    expect(f.details()).toHaveLength(2);
    for (const [status, type] of [['complete', 'goal_complete'], ['budgetLimited', 'goal_budget'], ['blocked', 'goal_blocked']]) {
      await f.runtime.sendGoalSettlePush({ sessionId: 's1', directory: '/project/a', status, title: 'Settled', body: 'Goal outcome' });
      expect(f.push.at(-1)).toMatchObject({ title: 'Settled', body: 'Goal outcome', data: { type, sessionName: 'Goal session' } });
    }
    expect(f.details()).toHaveLength(2);
  });

  it('suppresses subtasks when disabled but keeps the subtask template when enabled', async () => {
    const f = createFixture({ notifyOnSubtasks: false });
    f.respond(async () => Response.json({ title: 'Child', parentID: 'root' }));
    await f.trigger();
    expect(f.push).toHaveLength(0);
    expect(f.details()).toHaveLength(1);
    f.settings.notifyOnSubtasks = true;
    f.at(105_000);
    await f.trigger();
    expect(f.desktop[0].title).toBe('Subtask Child');
    expect(f.details()).toHaveLength(2);
  });

  it('does not turn unknown parent detail into a root-session success', async () => {
    const f = createFixture({ notifyOnSubtasks: false });
    f.respond(async () => new Response(null, { status: 404 }));
    await f.trigger();
    f.at(105_000);
    await f.trigger();
    expect(f.push).toHaveLength(0);
    expect(f.details()).toHaveLength(1);
    f.at(160_000);
    f.respond(async () => Response.json({ title: 'Root' }));
    await f.trigger();
    expect(f.desktop[0].title).toBe('Root');
    expect(f.details()).toHaveLength(2);
  });

  it('does not enrich disabled or focused notification paths', async () => {
    const f = createFixture({ notifyOnCompletion: false, notifyOnError: false });
    await f.trigger();
    await f.trigger(f.event('s1', '/project/a', 'error'));
    expect(f.reads).toHaveLength(0);
    f.settings.notifyOnCompletion = true;
    f.settings.notificationMode = 'hidden';
    f.focus(true);
    await f.trigger();
    expect(f.reads).toHaveLength(0);
    f.focus(false);
    await f.trigger();
    expect(f.push).toHaveLength(1);
  });
});
