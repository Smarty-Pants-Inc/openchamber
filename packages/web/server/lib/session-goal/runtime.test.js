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

const jsonResponse = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', ...headers },
});

const requestPath = (input) => new URL(String(input)).pathname;

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

  const assistantMessage = ({ id, created, completed = created, total, summary = false }) => ({
    info: {
      id,
      sessionID: SESSION_ID,
      role: 'assistant',
      providerID: 'provider',
      modelID: 'model',
      summary,
      time: { created, completed },
      tokens: { input: total, output: 0, cache: { read: 0 } },
    },
    parts: [{ type: 'text', text: 'Progress update.' }],
  });

  const tickRuntime = async (runtime) => {
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();
  };

  it('paginates backward until it reaches the persisted accounting cursor', async () => {
    let persistedGoal = {
      id: 'goal_cursor',
      objective: 'Finish the task',
      status: 'active',
      tokensUsed: 20,
      tokensBaseline: 0,
      tokensCommitted: 0,
      turnsUsed: 0,
      blockedStreak: 0,
      auditFailStreak: 0,
      lastAccountedMessageID: 'cursor-message',
      lastAccountedMessageIDs: ['cursor-message'],
      lastAccountedMessageTime: 100,
      createdAt: 1,
      updatedAt: 1,
    };
    const currentSession = () => ({
      id: SESSION_ID,
      directory: DIRECTORY,
      metadata: { openchamber: { goal: persistedGoal } },
    });
    const messageRequests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const url = new URL(String(input));
      const pathname = url.pathname;
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        persistedGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse(currentSession());
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(currentSession());
      if (pathname === '/session/status') return jsonResponse({});
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) {
        const before = url.searchParams.get('before');
        messageRequests.push(before);
        return before
          ? jsonResponse([assistantMessage({ id: 'cursor-message', created: 100, total: 20 })])
          : jsonResponse([
            assistantMessage({ id: 'pi_b', created: 110, total: 25 }),
            assistantMessage({ id: 'pi_a', created: 120, total: 30 }),
          ], 200, { 'x-next-cursor': 'older-page' });
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({
        generateSmallModelText: async () => ({
          text: '{"verdict":"complete","note":"Verified"}',
          providerID: 'provider',
          modelID: 'model',
        }),
      }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });

    await tickRuntime(runtime);

    expect(messageRequests).toEqual([null, 'older-page']);
    expect(persistedGoal).toMatchObject({
      status: 'complete',
      tokensUsed: 30,
      lastAccountedMessageID: 'pi_a',
      lastAccountedMessageIDs: ['pi_a'],
      lastAccountedMessageTime: 120,
    });
    runtime.stop();
  });

  it('persists every processed identity at an equal completion time across restarts', async () => {
    let persistedGoal = {
      id: 'goal_equal_time',
      objective: 'Finish the task',
      status: 'active',
      tokensUsed: 10,
      tokensBaseline: 0,
      tokensCommitted: 0,
      turnsUsed: 0,
      blockedStreak: 0,
      auditFailStreak: 0,
      lastAccountedMessageID: 'pi_z',
      lastAccountedMessageIDs: ['pi_z'],
      lastAccountedMessageTime: 100,
      createdAt: 1,
      updatedAt: 1,
    };
    let messages = [
      assistantMessage({ id: 'pi_z', created: 90, completed: 100, total: 10 }),
      assistantMessage({ id: 'pi_y', created: 91, completed: 100, total: 15 }),
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
    vi.stubGlobal('fetch', fetchImpl);
    const createRuntime = () => createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({
        generateSmallModelText: async () => ({
          text: '{"verdict":"continue","note":"Still working"}',
          providerID: 'provider',
          modelID: 'model',
        }),
      }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });

    let runtime = createRuntime();
    await tickRuntime(runtime);
    expect(persistedGoal).toMatchObject({
      tokensUsed: 15,
      lastAccountedMessageID: 'pi_y',
      lastAccountedMessageIDs: ['pi_z', 'pi_y'],
      lastAccountedMessageTime: 100,
    });
    runtime.stop();

    messages = [...messages, assistantMessage({ id: 'pi_x', created: 92, completed: 100, total: 20 })];
    runtime = createRuntime();
    await tickRuntime(runtime);
    expect(persistedGoal).toMatchObject({
      tokensUsed: 20,
      lastAccountedMessageID: 'pi_x',
      lastAccountedMessageIDs: ['pi_z', 'pi_y', 'pi_x'],
      lastAccountedMessageTime: 100,
    });
    runtime.stop();
  });

  it('closes a persisted summary segment before an unseen equal-time assistant message', async () => {
    let persistedGoal = {
      id: 'goal_equal_time_summary', objective: 'Finish the task', status: 'active', tokensUsed: 40,
      tokensBaseline: 20, tokensCommitted: 0, turnsUsed: 0, blockedStreak: 0, auditFailStreak: 0,
      lastAccountedMessageID: 'summary', lastAccountedMessageIDs: ['summary'],
      lastAccountedMessageTime: 100, createdAt: 1, updatedAt: 1,
    };
    const currentSession = () => ({
      id: SESSION_ID,
      directory: DIRECTORY,
      metadata: { openchamber: { goal: persistedGoal } },
    });
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        persistedGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse(currentSession());
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(currentSession());
      if (pathname === '/session/status') return jsonResponse({});
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([
        assistantMessage({ id: 'summary', created: 100, completed: 100, total: 0, summary: true }),
        assistantMessage({ id: 'equal-time-tail', created: 101, completed: 100, total: 10 }),
      ]);
      throw new Error(`Unexpected request: ${pathname}`);
    }));
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({
        generateSmallModelText: async () => ({
          text: '{"verdict":"complete","note":"Verified"}', providerID: 'provider', modelID: 'model',
        }),
      }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });

    await tickRuntime(runtime);

    expect(persistedGoal).toMatchObject({
      tokensUsed: 50,
      tokensCommitted: 40,
      tokensBaseline: 0,
      lastAccountedMessageIDs: ['summary', 'equal-time-tail'],
      lastAccountedMessageTime: 100,
    });
    runtime.stop();
  });

  it('replays a migrated summary barrier after history replacement across restart before enforcing the budget', async () => {
    let persistedGoal = {
      id: 'goal_removed_summary', objective: 'Finish the task', status: 'active', tokenBudget: 45,
      tokensUsed: 40, tokensBaseline: 20, tokensCommitted: 0, turnsUsed: 0, blockedStreak: 0, auditFailStreak: 0,
      lastAccountedMessageID: 'summary', lastAccountedMessageIDs: ['summary'],
      lastAccountedMessageTime: 100, createdAt: 1, updatedAt: 1,
    };
    let messages = [assistantMessage({ id: 'summary', created: 100, completed: 100, total: 0, summary: true })];
    const currentSession = () => ({
      id: SESSION_ID,
      directory: DIRECTORY,
      metadata: { openchamber: { goal: persistedGoal } },
    });
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
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
    }));
    const createRuntime = () => createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: vi.fn(),
      isEnabled: () => true,
      idleQuietMs: 10,
    });

    let runtime = createRuntime();
    await tickRuntime(runtime);
    expect(persistedGoal).toMatchObject({
      tokensUsed: 40,
      tokensCommitted: 40,
      tokensBaseline: 0,
      lastAccountedSummaryBoundaries: [{ id: 'summary', completedAt: 100, createdAt: 100 }],
    });
    runtime.stop();

    messages = [assistantMessage({ id: 'equal-time-tail', created: 101, completed: 100, total: 10 })];
    runtime = createRuntime();
    await tickRuntime(runtime);

    expect(persistedGoal).toMatchObject({
      status: 'budgetLimited',
      tokensUsed: 50,
      tokensCommitted: 40,
      tokensBaseline: 0,
      lastAccountedMessageID: 'equal-time-tail',
      lastAccountedMessageIDs: ['summary', 'equal-time-tail'],
      lastAccountedMessageTime: 100,
      lastAccountedSummaryBoundaries: [{ id: 'summary', completedAt: 100, createdAt: 100 }],
    });
    runtime.stop();
  });

  it('collects equal-time boundary identities across pages before stopping at an older assistant', async () => {
    let persistedGoal = {
      id: 'goal_equal_page_boundary',
      objective: 'Finish the task',
      status: 'active',
      tokensUsed: 10,
      tokensBaseline: 0,
      tokensCommitted: 0,
      turnsUsed: 0,
      blockedStreak: 0,
      auditFailStreak: 0,
      lastAccountedMessageID: 'known-boundary',
      lastAccountedMessageIDs: ['known-boundary'],
      lastAccountedMessageTime: 100,
      createdAt: 1,
      updatedAt: 1,
    };
    const currentSession = () => ({
      id: SESSION_ID,
      directory: DIRECTORY,
      metadata: { openchamber: { goal: persistedGoal } },
    });
    const messageRequests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const url = new URL(String(input));
      const pathname = url.pathname;
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        persistedGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse(currentSession());
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(currentSession());
      if (pathname === '/session/status') return jsonResponse({});
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) {
        const before = url.searchParams.get('before');
        messageRequests.push(before);
        if (!before) {
          return jsonResponse([
            assistantMessage({ id: 'known-boundary', created: 100, completed: 100, total: 10 }),
          ], 200, { 'x-next-cursor': 'equal-page' });
        }
        if (before === 'equal-page') {
          return jsonResponse([
            assistantMessage({ id: 'missing-boundary', created: 101, completed: 100, total: 15 }),
          ], 200, { 'x-next-cursor': 'older-page' });
        }
        return jsonResponse([
          assistantMessage({ id: 'older', created: 99, completed: 99, total: 9 }),
        ]);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({
        generateSmallModelText: async () => ({
          text: '{"verdict":"complete","note":"Verified"}',
          providerID: 'provider',
          modelID: 'model',
        }),
      }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });

    await tickRuntime(runtime);

    expect(messageRequests).toEqual([null, 'equal-page', 'older-page']);
    expect(persistedGoal).toMatchObject({
      status: 'complete',
      tokensUsed: 15,
      lastAccountedMessageID: 'missing-boundary',
      lastAccountedMessageIDs: ['known-boundary', 'missing-boundary'],
      lastAccountedMessageTime: 100,
    });
    runtime.stop();
  });

  it('paginates beyond the newest 40 messages to a compaction boundary', async () => {
    let persistedGoal = {
      id: 'goal_compaction',
      objective: 'Finish the task',
      status: 'active',
      tokensUsed: 30,
      tokensBaseline: 0,
      tokensCommitted: 0,
      turnsUsed: 0,
      blockedStreak: 0,
      auditFailStreak: 0,
      lastAccountedMessageID: 'removed-before-compaction',
      lastAccountedMessageIDs: ['removed-before-compaction'],
      lastAccountedMessageTime: 30,
      createdAt: 1,
      updatedAt: 1,
    };
    const newestPage = Array.from({ length: 40 }, (_, index) => assistantMessage({
      id: `pi_${40 - index}`,
      created: 61 + index,
      total: index + 1,
    }));
    const currentSession = () => ({
      id: SESSION_ID,
      directory: DIRECTORY,
      metadata: { openchamber: { goal: persistedGoal } },
    });
    const messageRequests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const url = new URL(String(input));
      const pathname = url.pathname;
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        persistedGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse(currentSession());
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(currentSession());
      if (pathname === '/session/status') return jsonResponse({});
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) {
        const before = url.searchParams.get('before');
        messageRequests.push(before);
        if (!before) return jsonResponse(newestPage, 200, { 'x-next-cursor': 'compaction-page' });
        if (before === 'compaction-page') {
          return jsonResponse([
            assistantMessage({ id: 'summary', created: 50, total: 0, summary: true }),
          ], 200, { 'x-next-cursor': 'pre-summary-page' });
        }
        return jsonResponse([
          assistantMessage({ id: 'pre-summary', created: 40, total: 40 }),
        ]);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({
        generateSmallModelText: async () => ({
          text: '{"verdict":"complete","note":"Verified"}',
          providerID: 'provider',
          modelID: 'model',
        }),
      }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });

    await tickRuntime(runtime);

    expect(messageRequests).toEqual([null, 'compaction-page', 'pre-summary-page']);
    expect(persistedGoal).toMatchObject({
      tokensUsed: 80,
      tokensCommitted: 40,
      lastAccountedMessageID: 'pi_1',
      lastAccountedMessageIDs: ['pi_1'],
      lastAccountedMessageTime: 100,
    });
    runtime.stop();
  });

  it('does not stop at one persisted identity when equal-time cursor identities span pages', async () => {
    let persistedGoal = {
      id: 'goal_equal_page', objective: 'Finish the task', status: 'active', tokensUsed: 20,
      tokensBaseline: 0, tokensCommitted: 0, turnsUsed: 0, blockedStreak: 0, auditFailStreak: 0,
      lastAccountedMessageID: 'boundary-b', lastAccountedMessageIDs: ['boundary-a', 'boundary-b'],
      lastAccountedMessageTime: 100, createdAt: 1, updatedAt: 1,
    };
    const currentSession = () => ({ id: SESSION_ID, directory: DIRECTORY, metadata: { openchamber: { goal: persistedGoal } } });
    const messageRequests = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const url = new URL(String(input));
      const pathname = url.pathname;
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        persistedGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse(currentSession());
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(currentSession());
      if (pathname === '/session/status') return jsonResponse({});
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) {
        const before = url.searchParams.get('before');
        messageRequests.push(before);
        return before
          ? jsonResponse([assistantMessage({ id: 'boundary-a', created: 90, completed: 100, total: 20 })])
          : jsonResponse([
            assistantMessage({ id: 'boundary-b', created: 91, completed: 100, total: 20 }),
            assistantMessage({ id: 'tail', created: 110, total: 30 }),
          ], 200, { 'x-next-cursor': 'older-boundary' });
      }
      throw new Error(`Unexpected request: ${pathname}`);
    }));
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: async () => ({ text: '{"verdict":"complete"}' }) }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });

    await tickRuntime(runtime);

    expect(messageRequests).toEqual([null, 'older-boundary']);
    runtime.stop();
  });

  it('pages a legacy singleton cursor through equal-time siblings and excludes only its known ID', async () => {
    let persistedGoal = {
      id: 'goal_legacy_singleton', objective: 'Finish the task', status: 'active', tokensUsed: 20,
      tokensBaseline: 0, tokensCommitted: 0, turnsUsed: 0, blockedStreak: 0, auditFailStreak: 0,
      lastAccountedMessageID: 'legacy-boundary', lastAccountedMessageTime: 100, createdAt: 1, updatedAt: 1,
    };
    const currentSession = () => ({ id: SESSION_ID, directory: DIRECTORY, metadata: { openchamber: { goal: persistedGoal } } });
    const messageRequests = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const url = new URL(String(input));
      const pathname = url.pathname;
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        persistedGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse(currentSession());
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(currentSession());
      if (pathname === '/session/status') return jsonResponse({});
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) {
        const before = url.searchParams.get('before');
        messageRequests.push(before);
        return before
          ? jsonResponse([
            assistantMessage({ id: 'older', created: 80, completed: 90, total: 10 }),
            assistantMessage({ id: 'equal-time-sibling', created: 90, completed: 100, total: 25 }),
          ])
          : jsonResponse([
            assistantMessage({ id: 'legacy-boundary', created: 91, completed: 100, total: 20 }),
          ], 200, { 'x-next-cursor': 'older-legacy-boundary' });
      }
      throw new Error(`Unexpected request: ${pathname}`);
    }));
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: async () => ({ text: '{"verdict":"complete"}' }) }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });

    await tickRuntime(runtime);

    expect(messageRequests).toEqual([null, 'older-legacy-boundary']);
    expect(persistedGoal).toMatchObject({
      tokensUsed: 25,
      lastAccountedMessageID: 'equal-time-sibling',
      lastAccountedMessageTime: 100,
      lastAccountedMessageIDs: ['legacy-boundary', 'equal-time-sibling'],
    });
    runtime.stop();
  });

  it('pages past intermediate unseen compactions until it crosses the durable cursor time', async () => {
    let persistedGoal = {
      id: 'goal_intermediate_compaction', objective: 'Finish the task', status: 'active', tokensUsed: 10,
      tokensBaseline: 0, tokensCommitted: 0, turnsUsed: 0, blockedStreak: 0, auditFailStreak: 0,
      lastAccountedMessageID: 'removed-boundary', lastAccountedMessageIDs: ['removed-boundary'],
      lastAccountedMessageTime: 30, createdAt: 1, updatedAt: 1,
    };
    const currentSession = () => ({ id: SESSION_ID, directory: DIRECTORY, metadata: { openchamber: { goal: persistedGoal } } });
    const messageRequests = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const url = new URL(String(input));
      const pathname = url.pathname;
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        persistedGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse(currentSession());
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(currentSession());
      if (pathname === '/session/status') return jsonResponse({});
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) {
        const before = url.searchParams.get('before');
        messageRequests.push(before);
        if (!before) return jsonResponse([assistantMessage({ id: 'tail', created: 100, total: 100 })], 200, { 'x-next-cursor': 'newer-summary' });
        if (before === 'newer-summary') return jsonResponse([
          assistantMessage({ id: 'before-newer-summary', created: 70, total: 70 }),
          assistantMessage({ id: 'newer-summary', created: 80, total: 0, summary: true }),
        ], 200, { 'x-next-cursor': 'older-summary' });
        if (before === 'older-summary') return jsonResponse([
          assistantMessage({ id: 'before-older-summary', created: 40, total: 40 }),
          assistantMessage({ id: 'older-summary', created: 50, total: 0, summary: true }),
        ], 200, { 'x-next-cursor': 'before-boundary' });
        return jsonResponse([assistantMessage({ id: 'before-boundary', created: 20, total: 20 })]);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    }));
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: async () => ({ text: '{"verdict":"complete"}' }) }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });

    await tickRuntime(runtime);

    expect(messageRequests).toEqual([null, 'newer-summary', 'older-summary', 'before-boundary']);
    expect(persistedGoal).toMatchObject({ tokensCommitted: 110, tokensUsed: 210 });
    runtime.stop();
  });

  it('re-arms the quiet timer after an older message page fails', async () => {
    const messageRequests = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const url = new URL(String(input));
      const pathname = url.pathname;
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') return jsonResponse(session);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({});
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) {
        const before = url.searchParams.get('before');
        messageRequests.push(before);
        if (!before) {
          return jsonResponse([assistantMessage({ id: 'tail', created: 2, total: 10 })], 200, { 'x-next-cursor': 'older-page' });
        }
        if (messageRequests.length === 2) return jsonResponse({ error: 'temporary failure' }, 503);
        return jsonResponse([assistantMessage({ id: 'before-goal', created: 1, total: 1 })]);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    }));
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: async () => ({ text: '{"verdict":"complete"}' }) }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });

    await tickRuntime(runtime);
    expect(messageRequests).toEqual([null, 'older-page']);
    await vi.advanceTimersByTimeAsync(10);
    expect(messageRequests).toEqual([null, 'older-page', null, 'older-page']);
    runtime.stop();
  });

  it('checks the post-write tail from the newest page without reusing the old cursor', async () => {
    let persistedGoal = {
      id: 'goal_final_tail', objective: 'Finish the task', status: 'active', turnsUsed: 0,
      tokensUsed: 0, tokensBaseline: 0, tokensCommitted: 0, blockedStreak: 0, auditFailStreak: 0,
      createdAt: 1, updatedAt: 1,
    };
    const currentSession = () => ({ id: SESSION_ID, directory: DIRECTORY, metadata: { openchamber: { goal: persistedGoal } } });
    const messageRequests = [];
    const promptRequests = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const url = new URL(String(input));
      const pathname = url.pathname;
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        persistedGoal = JSON.parse(init.body).metadata.openchamber.goal;
        return jsonResponse(currentSession());
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(currentSession());
      if (pathname === '/session/status') return jsonResponse({});
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) {
        messageRequests.push(url.searchParams.get('before'));
        const headers = messageRequests.length === 1 ? {} : { 'x-next-cursor': 'stale-older-page' };
        return jsonResponse([assistantMessage({ id: 'tail', created: 2, total: 10 })], 200, headers);
      }
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        promptRequests.push(init);
        return jsonResponse({});
      }
      throw new Error(`Unexpected request: ${pathname}`);
    }));
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: async () => ({ text: '{"verdict":"continue"}' }) }),
      isEnabled: () => true,
      idleQuietMs: 10,
    });

    await tickRuntime(runtime);

    expect(messageRequests).toEqual([null, null]);
    expect(promptRequests).toHaveLength(1);
    runtime.stop();
  });
});
