import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionGoalRuntime } from './runtime.js';

const SESSION_ID = 'ses_parent';
const CHILD_ID = 'ses_child';
const DIRECTORY = '/workspace';

const goal = {
  id: 'goal_1',
  objective: 'Finish the task',
  status: 'active',
  turnsUsed: 1,
  createdAt: 1,
  updatedAt: 1,
};

const session = {
  id: SESSION_ID,
  directory: DIRECTORY,
  metadata: { openchamber: { goal } },
};

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const requestPath = (input) => new URL(typeof input === 'string' ? input : input.url).pathname;

const startIdleTick = async (fetchImpl) => {
  const getSmallModelService = vi.fn();
  vi.stubGlobal('fetch', fetchImpl);
  const runtime = createSessionGoalRuntime({
    buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
    getOpenCodeAuthHeaders: () => ({}),
    getSmallModelService,
    isEnabled: () => true,
    idleQuietMs: 10,
  });
  runtime.processPayload({
    type: 'session.status',
    properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
  });
  await vi.runOnlyPendingTimersAsync();
  return { runtime, getSmallModelService };
};

describe('session goal live activity gate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('waits for the next parent idle when the parent resumed during the quiet window', async () => {
    const paths = [];
    const { runtime, getSmallModelService } = await startIdleTick(vi.fn(async (input) => {
      const pathname = requestPath(input);
      paths.push(pathname);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'busy' } });
      throw new Error(`Unexpected request: ${pathname}`);
    }));

    expect(paths).toEqual([`/session/${SESSION_ID}`, '/session/status']);
    expect(getSmallModelService).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(paths).toHaveLength(2);
    runtime.stop();
  });

  it('waits for the parent result cycle while a direct child is working', async () => {
    const paths = [];
    const { runtime, getSmallModelService } = await startIdleTick(vi.fn(async (input) => {
      const pathname = requestPath(input);
      paths.push(pathname);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({ [CHILD_ID]: { type: 'busy' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([{ id: CHILD_ID, parentID: SESSION_ID }]);
      throw new Error(`Unexpected request: ${pathname}`);
    }));

    expect(paths).toEqual([
      `/session/${SESSION_ID}`,
      '/session/status',
      `/session/${SESSION_ID}/children`,
    ]);
    expect(getSmallModelService).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(paths).toHaveLength(3);
    runtime.stop();
  });

  it('retries the quiet window when live status cannot be read', async () => {
    const paths = [];
    const { runtime, getSmallModelService } = await startIdleTick(vi.fn(async (input) => {
      const pathname = requestPath(input);
      paths.push(pathname);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({ error: 'unavailable' }, 503);
      throw new Error(`Unexpected request: ${pathname}`);
    }));

    expect(paths).toEqual([`/session/${SESSION_ID}`, '/session/status']);
    expect(getSmallModelService).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10);
    expect(paths).toEqual([
      `/session/${SESSION_ID}`,
      '/session/status',
      `/session/${SESSION_ID}`,
      '/session/status',
    ]);
    runtime.stop();
  });

  it('audits normally when the idle parent has no working children', async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET', body: init.body });
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') return jsonResponse(session);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({});
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) {
        return jsonResponse([{
          info: {
            id: 'msg_assistant',
            sessionID: SESSION_ID,
            role: 'assistant',
            providerID: 'provider',
            modelID: 'model',
            time: { completed: 2 },
            tokens: { input: 1, output: 1, cache: { read: 0 } },
          },
          parts: [{ type: 'text', text: 'The task is verified complete.' }],
        }]);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    const service = {
      generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"complete","note":"Task verified complete"}',
        providerID: 'provider',
        modelID: 'model',
      })),
    };
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => service,
      isEnabled: () => true,
      idleQuietMs: 10,
    });

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();

    expect(service.generateSmallModelText).toHaveBeenCalledOnce();
    const patch = requests.find((request) => request.pathname === `/session/${SESSION_ID}` && request.method === 'PATCH');
    expect(patch).toBeDefined();
    const writtenGoal = JSON.parse(patch.body).metadata.openchamber.goal;
    expect(writtenGoal).toMatchObject({
      status: 'complete',
      evaluationProviderID: 'provider',
      evaluationModelID: 'model',
    });
    runtime.stop();
  });
});

describe('session goal token accounting cursor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('accounts OMP rollover and descending Pi IDs through compaction after a runtime restart', async () => {
    let persistedGoal = {
      id: 'goal_pi',
      objective: 'Finish the task',
      status: 'active',
      tokensUsed: 0,
      tokensBaseline: 0,
      tokensCommitted: 0,
      turnsUsed: 0,
      blockedStreak: 0,
      auditFailStreak: 0,
      lastAccountedMessageID: '',
      lastAccountedMessageTime: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const assistantMessage = ({ id, created, total, summary = false }) => ({
      info: {
        id,
        sessionID: SESSION_ID,
        role: 'assistant',
        providerID: 'provider',
        modelID: 'model',
        summary,
        time: { created, completed: created },
        tokens: { input: total, output: 0, cache: { read: 0 } },
      },
      parts: [{ type: 'text', text: 'Progress update.' }],
    });
    const messages = [
      assistantMessage({ id: 'msg_ffffffffffff', created: 10, total: 10 }),
      assistantMessage({ id: 'msg_000000000000', created: 20, total: 20 }),
      assistantMessage({ id: 'pi_z', created: 30, total: 30 }),
      assistantMessage({ id: 'pi_y', created: 40, total: 40 }),
    ];
    const currentSession = () => ({
      id: SESSION_ID,
      directory: DIRECTORY,
      metadata: { openchamber: { goal: persistedGoal } },
    });
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        persistedGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse(currentSession());
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(currentSession());
      if (pathname === '/session/status') return jsonResponse({});
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse(messages);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) return jsonResponse({});
      throw new Error(`Unexpected request: ${pathname}`);
    });
    const service = {
      generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"Still working"}',
        providerID: 'provider',
        modelID: 'model',
      })),
    };
    const createRuntime = () => createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => service,
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    const tick = async (runtime) => {
      runtime.processPayload({
        type: 'session.status',
        properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
      });
      await vi.runOnlyPendingTimersAsync();
    };
    vi.stubGlobal('fetch', fetchImpl);

    let runtime = createRuntime();
    await tick(runtime);
    expect(persistedGoal).toMatchObject({ tokensUsed: 40, lastAccountedMessageID: 'pi_y', lastAccountedMessageTime: 40 });

    messages.unshift(assistantMessage({ id: 'pi_x', created: 50, total: 0, summary: true }));
    await tick(runtime);
    expect(persistedGoal).toMatchObject({
      tokensUsed: 40,
      tokensCommitted: 40,
      lastAccountedMessageID: 'pi_x',
      lastAccountedMessageTime: 50,
    });
    runtime.stop();

    messages.push(assistantMessage({ id: 'pi_w', created: 60, total: 7 }));
    runtime = createRuntime();
    await tick(runtime);
    expect(persistedGoal).toMatchObject({
      tokensUsed: 47,
      tokensCommitted: 40,
      lastAccountedMessageID: 'pi_w',
      lastAccountedMessageTime: 60,
    });
    runtime.stop();

    messages.splice(0, messages.length,
      assistantMessage({ id: 'retained-old', created: 10, total: 10 }),
      assistantMessage({ id: 'paged-new', created: 70, total: 9 }),
    );
    runtime = createRuntime();
    await tick(runtime);
    expect(persistedGoal).toMatchObject({
      tokensUsed: 49,
      tokensCommitted: 40,
      lastAccountedMessageID: 'paged-new',
      lastAccountedMessageTime: 70,
    });
    runtime.stop();
  });
});
