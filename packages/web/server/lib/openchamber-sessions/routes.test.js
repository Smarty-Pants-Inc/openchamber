import express from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const createWorktreeMock = vi.fn(async () => ({
  head: 'abc123',
  createdHead: 'abc123',
  name: 'side-task',
  branch: 'openchamber/side-task',
  path: '/repo/worktrees/side-task',
}));
const removeWorktreeMock = vi.fn(async () => true);
const cancelWorktreeBootstrapMock = vi.fn(async () => ({
  settled: true,
  attached: true,
  branch: 'openchamber/side-task',
  clean: true,
  safeToRemove: true,
  createdHead: 'abc123',
  currentHead: 'abc123',
  bootstrapStatus: { status: 'ready', phase: 'setup-ready' },
}));
const getWorktreeBootstrapStatusMock = vi.fn(async () => ({
  status: 'ready',
  phase: 'setup-ready',
  error: null,
  updatedAt: Date.now(),
}));
const sessionCreateMock = vi.fn(async () => ({ data: { id: 'ses_123', directory: '/repo/app' } }));
const sessionForkMock = vi.fn(async () => ({ data: { id: 'ses_fork', directory: '/repo/app', title: 'Forked session' } }));
const sessionUpdateMock = vi.fn(async ({ sessionID, metadata }) => ({ data: { id: sessionID, metadata } }));
const sessionGetMock = vi.fn(async ({ sessionID }) => ({ data: { id: sessionID, metadata: {} } }));
const sessionDeleteMock = vi.fn(async () => ({ data: true }));
const sessionMessagesMock = vi.fn(async () => ({ data: [] }));

let existingSessionMessages = [];
let dispatchedUserMessageSeq = 0;

// The service confirms a prompt landed by watching for a new user message, so
// the default mock behaves like OpenCode recording each dispatched prompt.
const setSessionMessages = (messages) => {
  existingSessionMessages = messages;
};

const recordedSessionMessages = async () => {
  dispatchedUserMessageSeq += 1;
  return {
    data: [
      ...existingSessionMessages,
      {
        info: {
          id: `msg_dispatched_${dispatchedUserMessageSeq}`,
          role: 'user',
          time: { created: 1000 + dispatchedUserMessageSeq },
        },
      },
    ],
  };
};

// Selection inputs are fetched whenever a request names a model, agent, or
// variant, so every prompt-dispatching fetch mock must answer them.
const selectionInputResponse = (url) => {
  const text = String(url);
  if (text.includes('/config/providers')) {
    return {
      ok: true,
      json: async () => ({
        providers: [
          { id: 'openai', models: [{ id: 'gpt-5.5', variants: { high: {} } }] },
          { id: 'anthropic', models: [{ id: 'claude-sonnet-5', variants: { high: {} } }] },
          { id: 'pi', models: [{ id: 'anthropic/claude-sonnet-4-5', variants: { high: {} } }] },
          { id: 'omp', models: [{ id: 'gpt-5.5', variants: { high: {} } }] },
        ],
      }),
    };
  }
  if (text.includes('/agent')) {
    return { ok: true, json: async () => [{ name: 'build', mode: 'primary' }, { name: 'plan', mode: 'primary' }] };
  }
  if (text.includes('/config')) return { ok: true, json: async () => ({}) };
  return null;
};

const createdSessionResponse = (url) => ({
  id: 'ses_123',
  directory: url ? new URL(String(url)).searchParams.get('directory') || '/repo/app' : '/repo/app',
});
const sessionCommandMock = vi.fn(async () => ({ data: {} }));
const commandListMock = vi.fn(async () => ({ data: [] }));
globalThis.__openchamberCreateWorktreeMock = createWorktreeMock;
globalThis.__openchamberGetWorktreeBootstrapStatusMock = getWorktreeBootstrapStatusMock;
globalThis.__openchamberRemoveWorktreeMock = removeWorktreeMock;
globalThis.__openchamberCancelWorktreeBootstrapMock = cancelWorktreeBootstrapMock;

let createOpenChamberSessionService;
let registerOpenChamberSessionRoutes;

vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: () => ({
    session: {
      create: sessionCreateMock,
      fork: sessionForkMock,
      get: sessionGetMock,
      delete: sessionDeleteMock,
      update: sessionUpdateMock,
      messages: sessionMessagesMock,
      command: sessionCommandMock,
    },
    command: {
      list: commandListMock,
    },
  }),
}));

vi.mock('../git/index.js', () => ({
  cancelWorktreeBootstrap: (...args) => globalThis.__openchamberCancelWorktreeBootstrapMock(...args),
  createWorktree: (...args) => globalThis.__openchamberCreateWorktreeMock(...args),
  getWorktreeBootstrapStatus: (...args) => globalThis.__openchamberGetWorktreeBootstrapStatusMock(...args),
  removeWorktree: (...args) => globalThis.__openchamberRemoveWorktreeMock(...args),
}));

const createApp = (overrides = {}, options = {}) => {
  const app = express();
  if (options.globalJson !== false) {
    app.use(express.json());
  }
  const calls = [];
  registerOpenChamberSessionRoutes(app, {
    readSettingsFromDiskMigrated: async () => ({ projects: [{ id: 'proj_1', path: '/repo/app' }] }),
    sanitizeProjects: (projects) => projects,
    validateDirectoryPath: async (directory) => ({ ok: true, directory }),
    buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test' }),
    waitForOpenCodeReady: vi.fn(async () => undefined),
    ...overrides,
  });
  return { app, calls };
};

const createSessionService = (overrides = {}) => createOpenChamberSessionService({
  readSettingsFromDiskMigrated: async () => ({ projects: [{ id: 'proj_1', path: '/repo/app' }] }),
  sanitizeProjects: (projects) => projects,
  validateDirectoryPath: async (directory) => ({ ok: true, directory }),
  buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
  getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test' }),
  waitForOpenCodeReady: vi.fn(async () => undefined),
  ...overrides,
});

describe('openchamber session routes', () => {
  beforeAll(async () => {
    ({ createOpenChamberSessionService, registerOpenChamberSessionRoutes } = await import('./routes.js'));
  });

  beforeEach(() => {
    createWorktreeMock.mockClear();
    getWorktreeBootstrapStatusMock.mockClear();
    removeWorktreeMock.mockClear();
    cancelWorktreeBootstrapMock.mockClear();
    cancelWorktreeBootstrapMock.mockResolvedValue({
      settled: true,
      attached: true,
      branch: 'openchamber/side-task',
      clean: true,
      safeToRemove: true,
      createdHead: 'abc123',
      currentHead: 'abc123',
      bootstrapStatus: { status: 'ready', phase: 'setup-ready' },
    });
    getWorktreeBootstrapStatusMock.mockImplementation(async () => ({
      status: 'ready',
      phase: 'setup-ready',
      error: null,
      updatedAt: Date.now(),
    }));
    sessionCreateMock.mockReset();
    sessionCreateMock.mockResolvedValue({ data: { id: 'ses_123', directory: '/repo/app' } });
    sessionForkMock.mockReset();
    sessionForkMock.mockResolvedValue({ data: { id: 'ses_fork', directory: '/repo/app', title: 'Forked session' } });
    sessionUpdateMock.mockReset();
    sessionGetMock.mockReset();
    sessionGetMock.mockImplementation(async ({ sessionID }) => ({ data: { id: sessionID, metadata: {} } }));
    sessionUpdateMock.mockImplementation(async ({ sessionID, metadata }) => ({ data: { id: sessionID, metadata } }));
    sessionDeleteMock.mockClear();
    sessionDeleteMock.mockResolvedValue({ data: true });
    existingSessionMessages = [];
    dispatchedUserMessageSeq = 0;
    sessionMessagesMock.mockReset();
    sessionMessagesMock.mockImplementation(recordedSessionMessages);
    sessionCommandMock.mockReset();
    sessionCommandMock.mockResolvedValue({ data: {} });
    commandListMock.mockReset();
    commandListMock.mockResolvedValue({ data: [] });
  });

  it('applies a scoped metadata compare-and-swap without replacing sibling state', async () => {
    let session = {
      id: 'ses_metadata',
      metadata: { keep: true, openchamber: { assist: { suggestion: 'Preserve me' } } },
    };
    sessionGetMock.mockImplementation(async () => ({ data: session }));
    sessionUpdateMock.mockImplementation(async ({ metadata }) => {
      session = { ...session, metadata };
      return { data: session };
    });
    const { app } = createApp();

    const response = await request(app)
      .patch('/api/openchamber/sessions/ses_metadata/metadata')
      .send({
        directory: '/repo/app',
        operations: [{
          type: 'set',
          path: ['openchamber', 'goal'],
          expected: { exists: false },
          value: { id: 'goal-a', status: 'active' },
        }],
      })
      .expect(200);

    expect(response.body.session.metadata).toEqual({
      keep: true,
      openchamber: {
        assist: { suggestion: 'Preserve me' },
        goal: { id: 'goal-a', status: 'active' },
      },
    });
    expect(sessionUpdateMock).toHaveBeenCalledWith({
      sessionID: 'ses_metadata',
      directory: '/repo/app',
      metadata: response.body.session.metadata,
    });

    await request(app)
      .patch('/api/openchamber/sessions/ses_metadata/metadata')
      .send({
        directory: '/repo/app',
        operations: [{
          type: 'set',
          path: ['openchamber', 'goal'],
          expected: { exists: false },
          value: { id: 'goal-b' },
        }],
      })
      .expect(409);
    expect(sessionUpdateMock).toHaveBeenCalledOnce();
  });

  it('compensates a session create that returns after its caller cancels', async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    sessionGetMock.mockImplementation(async ({ sessionID }) => (
      sessionID === 'ses_123'
        ? { response: { status: 404 } }
        : { data: { id: sessionID, metadata: {} } }
    ));
    globalThis.fetch = vi.fn(async () => {
      controller.abort();
      return { ok: true, json: async () => createdSessionResponse() };
    });
    try {
      const service = createSessionService();
      await expect(service.create({ directory: '/repo/app' }, { signal: controller.signal }))
        .rejects.toMatchObject({ statusCode: 499 });

      expect(sessionDeleteMock).toHaveBeenCalledWith({
        sessionID: 'ses_123',
        directory: '/repo/app',
      }, expect.any(Object));
      expect(sessionGetMock).toHaveBeenLastCalledWith({
        sessionID: 'ses_123',
        directory: '/repo/app',
      }, expect.any(Object));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('creates a session for a directory', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => createdSessionResponse() }));
    try {
      const { app } = createApp();
      const response = await request(app)
        .post('/api/openchamber/sessions')
        .send({ directory: '/repo/app', title: 'Side task' })
        .expect(200);

      expect(response.body.sessionId).toBeTruthy();
      expect(response.body.sessionId).toBe('ses_123');
      expect(response.body.directory).toBe('/repo/app');
      expect(response.body.promptDispatched).toBe(false);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://opencode.test/session?directory=%2Frepo%2Fapp',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ directory: '/repo/app', title: 'Side task' }),
        }),
      );
      expect(sessionCreateMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails closed when session creation omits its authoritative directory', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ id: 'ses_123' }) }));
    try {
      await expect(createSessionService().create({ directory: '/repo/app' })).rejects.toMatchObject({
        statusCode: 502,
        partial: true,
        partialAction: 'session-retained',
        sessionId: 'ses_123',
        recovery: { session: { confirmed: false } },
      });
      expect(sessionDeleteMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects a promptless Pi create before raw session dispatch', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    try {
      await expect(createSessionService().create({
        directory: '/repo/app',
        model: 'pi/anthropic/claude-sonnet-4-5',
      })).rejects.toMatchObject({
        name: 'OpenChamberControlError',
        statusCode: 409,
        message: 'Pi session creation requires an interactive client to own startup dialogs',
      });

      const { app } = createApp();
      await request(app)
        .post('/api/openchamber/sessions')
        .send({ directory: '/repo/app', model: 'pi/anthropic/claude-sonnet-4-5' })
        .expect(409, { error: 'Pi session creation requires an interactive client to own startup dialogs' });

      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('parses JSON body without global middleware', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => createdSessionResponse() }));
    try {
      const { app } = createApp({}, { globalJson: false });
      const response = await request(app)
        .post('/api/openchamber/sessions')
        .send({ directory: '/repo/app' })
        .expect(200);

      expect(response.body.sessionId).toBe('ses_123');
      expect(response.body.directory).toBe('/repo/app');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('emits a session-created event after creating a session', async () => {
    const originalFetch = globalThis.fetch;
    const emitSessionCreatedEvent = vi.fn();
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => createdSessionResponse() }));
    try {
      const { app } = createApp({ emitSessionCreatedEvent });
      await request(app)
        .post('/api/openchamber/sessions')
        .send({ directory: '/repo/app', title: 'Side task' })
        .expect(200);

      expect(emitSessionCreatedEvent).toHaveBeenCalledWith(expect.objectContaining({
        sessionID: 'ses_123',
        directory: '/repo/app',
        title: 'Side task',
        promptDispatched: false,
        dispatchedAsCommand: false,
      }));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects a default Pi selection before creating or prompting a session', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url) => {
      const text = String(url);
      if (text.includes('/config/providers')) {
        return { ok: true, json: async () => ({ providers: [{ id: 'pi', models: { 'anthropic/claude-sonnet-4-5': { id: 'anthropic/claude-sonnet-4-5' } } }] }) };
      }
      if (text.includes('/agent')) {
        return { ok: true, json: async () => [{ name: 'build', mode: 'primary' }] };
      }
      if (text.includes('/config')) {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => createdSessionResponse(url) };
    });
    globalThis.fetch = fetchMock;
    const { app } = createApp({
      readSettingsFromDiskMigrated: async () => ({
        defaultModel: 'pi/anthropic/claude-sonnet-4-5',
        defaultAgent: 'build',
        projects: [{ id: 'proj_1', path: '/repo/app' }],
      }),
    });
    try {
      await request(app)
        .post('/api/openchamber/sessions')
        .send({ directory: '/repo/app', prompt: 'Run this' })
        .expect(409, { error: 'Pi session creation requires an interactive client to own startup dialogs' });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://opencode.test/config/providers?directory=%2Frepo%2Fapp',
        expect.any(Object),
      );
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/session?directory='))).toBe(false);
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/prompt_async'))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('dispatches an initial prompt when model is provided', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('/prompt_async')) {
        return { ok: true, text: async () => '' };
      }
      return { ok: true, json: async () => createdSessionResponse(url) };
    });
    globalThis.fetch = fetchMock;
    try {
      const { app } = createApp();
      const response = await request(app)
        .post('/api/openchamber/sessions')
        .send({ directory: '/repo/app', prompt: 'Run this', model: 'omp/gpt-5.5' })
        .expect(200);

      expect(response.body.sessionId).toBe('ses_123');
      expect(response.body.promptDispatched).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://opencode.test/session/ses_123/prompt_async?directory=%2Frepo%2Fapp',
        expect.objectContaining({ method: 'POST' }),
      );
      const createCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/session?directory='));
      expect(JSON.parse(createCall?.[1]?.body)).toMatchObject({
        metadata: { openchamber: { agent_backend: 'omp' } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('creates goal metadata before dispatching the initial goal prompt', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('/prompt_async')) return { ok: true, text: async () => '' };
      return { ok: true, json: async () => createdSessionResponse(url) };
    });
    const createSessionGoal = vi.fn(async () => undefined);
    globalThis.fetch = fetchMock;
    try {
      const { app } = createApp({ createSessionGoal });
      const response = await request(app)
        .post('/api/openchamber/sessions')
        .send({
          directory: '/repo/app',
          prompt: 'Finish and verify the migration',
          model: 'openai/gpt-5.5',
          goal: true,
          goalTokenBudget: 200000,
        })
        .expect(200);

      const promptCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/prompt_async'));
      const promptPayload = JSON.parse(promptCall[1].body);
      expect(createSessionGoal).toHaveBeenCalledWith(expect.objectContaining({
        sessionID: 'ses_123',
        directory: '/repo/app',
        objective: 'Finish and verify the migration',
        tokenBudget: 200000,
        providerID: 'openai',
        modelID: 'gpt-5.5',
      }));
      expect(createSessionGoal.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder.at(-1));
      expect(promptPayload.parts).toEqual([
        { type: 'text', text: 'Finish and verify the migration' },
        expect.objectContaining({ type: 'text', synthetic: true }),
      ]);
      expect(response.body).toMatchObject({ goalEnabled: true, goalTokenBudget: 200000, promptDispatched: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects invalid goal requests before creating a session', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/openchamber/sessions')
        .send({ directory: '/repo/app', goal: true })
        .expect(400, { error: 'prompt is required when goal is enabled' });
      await request(app)
        .post('/api/openchamber/sessions')
        .send({ directory: '/repo/app', prompt: 'Run', goalTokenBudget: 200000 })
        .expect(400, { error: 'goalTokenBudget requires goal' });
      await request(app)
        .post('/api/openchamber/sessions')
        .send({ directory: '/repo/app', prompt: 'Run', goal: true, goalTokenBudget: 999 })
        .expect(400, { error: 'goalTokenBudget must be an integer from 1000 to 100000000' });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses the canonical child directory returned after worktree session creation', async () => {
    const originalFetch = globalThis.fetch;
    const emitSessionCreatedEvent = vi.fn();
    globalThis.fetch = vi.fn(async (url) => {
      const requestUrl = String(url);
      if (requestUrl.includes('/prompt_async')) {
        return { ok: true, text: async () => '' };
      }
      if (requestUrl.includes('/session?directory=')) {
        return { ok: true, json: async () => ({ id: 'ses_123', directory: '/canonical/worktrees/side-task' }) };
      }
      return selectionInputResponse(url);
    });
    try {
      const { app } = createApp({ emitSessionCreatedEvent });
      const response = await request(app)
        .post('/api/openchamber/sessions')
        .send({
          directory: '/repo/app',
          worktree: { name: 'side-task', branchName: 'openchamber/side-task', startRef: 'main' },
          setUpstream: false,
          prompt: 'Run this',
          model: 'openai/gpt-5.5',
        })
        .expect(200);

      expect(createWorktreeMock).toHaveBeenCalledWith(
        '/repo/app',
        {
          mode: 'new',
          name: 'side-task',
          branchName: 'openchamber/side-task',
          startRef: 'main',
          setUpstream: false,
        },
        { signal: expect.any(AbortSignal) },
      );
      expect(response.body.directory).toBe('/canonical/worktrees/side-task');
      expect(response.body.worktree.path).toBe('/repo/worktrees/side-task');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://opencode.test/session?directory=%2Frepo%2Fworktrees%2Fside-task',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://opencode.test/session/ses_123/prompt_async?directory=%2Fcanonical%2Fworktrees%2Fside-task',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(emitSessionCreatedEvent).toHaveBeenCalledWith(expect.objectContaining({
        sessionID: 'ses_123',
        directory: '/canonical/worktrees/side-task',
        worktree: expect.objectContaining({ path: '/repo/worktrees/side-task' }),
      }));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reacquires OpenCode credentials after worktree bootstrap', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url) => ({ ok: true, json: async () => createdSessionResponse(url) }));
    let credentialVersion = 0;
    const getOpenCodeAuthHeaders = vi.fn(() => ({ Authorization: `Bearer credential-${++credentialVersion}` }));
    globalThis.fetch = fetchMock;
    try {
      const { app } = createApp({ getOpenCodeAuthHeaders });
      await request(app)
        .post('/api/openchamber/sessions')
        .send({ directory: '/repo/app', worktree: { name: 'side-task' } })
        .expect(200);

      const sessionRequest = fetchMock.mock.calls.find(([url]) => String(url).includes('/session?directory='));
      expect(getOpenCodeAuthHeaders).toHaveBeenCalledTimes(2);
      expect(sessionRequest?.[1]?.headers).toMatchObject({ Authorization: 'Bearer credential-2' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('compensates a worktree when target default selection fails after bootstrap', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => {
      const text = String(url);
      if (text.includes('/config/providers')) return { ok: true, json: async () => ({ providers: [] }) };
      if (text.includes('/agent')) return { ok: true, json: async () => [] };
      if (text.includes('/config')) return { ok: true, json: async () => ({}) };
      throw new Error(`Unexpected request: ${text}`);
    });
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/openchamber/sessions')
        .send({
          directory: '/repo/app',
          worktree: { name: 'side-task' },
          prompt: 'Run this',
        })
        .expect(400, { error: 'No model is configured or available for the requested directory' });

      expect(createWorktreeMock).toHaveBeenCalledOnce();
      expect(removeWorktreeMock).toHaveBeenCalledWith('/repo/app', {
        directory: '/repo/worktrees/side-task',
        deleteLocalBranch: true,
        expectedBranch: 'openchamber/side-task',
        requireClean: true,
      });
      expect(cancelWorktreeBootstrapMock).toHaveBeenCalledWith('/repo/worktrees/side-task', 5_000);
      expect(cancelWorktreeBootstrapMock.mock.invocationCallOrder[0]).toBeLessThan(removeWorktreeMock.mock.invocationCallOrder[0]);
      expect(globalThis.fetch.mock.calls.some(([url]) => String(url).includes('directory=%2Frepo%2Fworktrees%2Fside-task'))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('removes a new worktree when its scoped selection resolves to Pi', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => {
      const response = selectionInputResponse(url);
      if (response) return response;
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/openchamber/sessions')
        .send({
          directory: '/repo/app',
          worktree: { name: 'side-task' },
          prompt: 'Run this',
          model: 'pi/anthropic/claude-sonnet-4-5',
          agent: 'build',
        })
        .expect(409, { error: 'Pi session creation requires an interactive client to own startup dialogs' });

      expect(createWorktreeMock).toHaveBeenCalledOnce();
      expect(cancelWorktreeBootstrapMock).toHaveBeenCalledWith('/repo/worktrees/side-task', 5_000);
      expect(removeWorktreeMock).toHaveBeenCalledOnce();
      expect(globalThis.fetch.mock.calls.some(([url]) => String(url).includes('/session?directory='))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });


  it('waits for the worktree bootstrap to complete before creating the session', async () => {
    const statuses = [
      { status: 'pending', phase: 'directory-created', error: null, updatedAt: 1 },
      { status: 'pending', phase: 'git-ready', error: null, updatedAt: 2 },
      { status: 'ready', phase: 'setup-ready', error: null, updatedAt: 3 },
    ];
    getWorktreeBootstrapStatusMock.mockImplementation(async () => statuses.shift() || statuses[statuses.length - 1]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('/prompt_async')) {
        return { ok: true, text: async () => '' };
      }
      return { ok: true, json: async () => createdSessionResponse(url) };
    });
    try {
      const { app } = createApp();
      const response = await request(app)
        .post('/api/openchamber/sessions')
        .send({
          directory: '/repo/app',
          worktree: { name: 'side-task' },
          prompt: 'Run this',
          model: 'openai/gpt-5.5',
        })
        .expect(200);

      expect(response.body.promptDispatched).toBe(true);
      const sessionCreateCalls = globalThis.fetch.mock.calls.filter(([url]) => String(url).includes('/session?directory'));
      const promptCalls = globalThis.fetch.mock.calls.filter(([url]) => String(url).includes('/prompt_async'));
      expect(sessionCreateCalls.length).toBeGreaterThanOrEqual(1);
      expect(promptCalls.length).toBeGreaterThanOrEqual(1);
      const createIndex = globalThis.fetch.mock.calls.indexOf(sessionCreateCalls[0]);
      const promptIndex = globalThis.fetch.mock.calls.indexOf(promptCalls[0]);
      expect(getWorktreeBootstrapStatusMock).toHaveBeenCalled();
      expect(createIndex).toBeGreaterThan(-1);
      expect(promptIndex).toBeGreaterThan(createIndex);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails the create when the worktree bootstrap failed', async () => {
    getWorktreeBootstrapStatusMock.mockImplementation(async () => ({
      status: 'failed',
      phase: 'directory-created',
      error: 'branch already exists',
      updatedAt: Date.now(),
    }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => ({ ok: true, json: async () => createdSessionResponse(url) }));
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/openchamber/sessions')
        .send({
          directory: '/repo/app',
          worktree: { name: 'side-task' },
          prompt: 'Run this',
          model: 'openai/gpt-5.5',
        })
        .expect(500, { error: 'Worktree bootstrap failed: branch already exists' });
      const promptCalls = globalThis.fetch.mock.calls.filter(([url]) => String(url).includes('/prompt_async'));
      expect(promptCalls.length).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('sends a goal prompt to an existing session after creating goal metadata', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url) => selectionInputResponse(url) || { ok: true, text: async () => '' });
    const createSessionGoal = vi.fn(async () => undefined);
    globalThis.fetch = fetchMock;
    try {
      setSessionMessages([{ info: { id: 'msg_before', role: 'assistant', time: { created: 10, completed: 20 } } }]);
      const { app } = createApp({ createSessionGoal });
      const response = await request(app)
        .post('/api/openchamber/sessions/ses_source/send')
        .send({
          directory: '/repo/app',
          prompt: 'Apply and verify the review feedback',
          model: 'openai/gpt-5.5',
          agent: 'build',
          variant: 'high',
          goal: true,
          goalTokenBudget: 200000,
        })
        .expect(200);

      expect(response.body).toMatchObject({
        action: 'send',
        sessionId: 'ses_source',
        directory: '/repo/app',
        promptDispatched: true,
        goalEnabled: true,
        baselineAssistantMessageId: 'msg_before',
      });
      expect(createSessionGoal).toHaveBeenCalledWith(expect.objectContaining({
        sessionID: 'ses_source',
        directory: '/repo/app',
        objective: 'Apply and verify the review feedback',
      }));
      const promptCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/prompt_async'));
      expect(promptCall?.[0]).toBe('http://opencode.test/session/ses_source/prompt_async?directory=%2Frepo%2Fapp');
      expect(createSessionGoal.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder.at(-1));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses the expanded slash-command template as the goal objective before command dispatch', async () => {
    const originalFetch = globalThis.fetch;
    const createSessionGoal = vi.fn(async () => undefined);
    commandListMock.mockResolvedValue({
      data: [{
        name: 'issue--to-pr',
        template: 'Take $ARGUMENTS from issue through a verified pull request. Confirm the PR covers $ARGUMENTS.',
      }],
    });
    globalThis.fetch = vi.fn(async (url) => selectionInputResponse(url));
    try {
      const { app } = createApp({ createSessionGoal });
      const response = await request(app)
        .post('/api/openchamber/sessions/ses_source/send')
        .send({
          directory: '/repo/app',
          prompt: '/issue--to-pr LIN-123',
          model: 'openai/gpt-5.5',
          agent: 'build',
          goal: true,
        })
        .expect(200);

      expect(createSessionGoal).toHaveBeenCalledWith(expect.objectContaining({
        objective: 'Take LIN-123 from issue through a verified pull request. Confirm the PR covers LIN-123.',
      }));
      expect(sessionCommandMock).toHaveBeenCalledWith(expect.objectContaining({
        command: 'issue--to-pr',
        arguments: 'LIN-123',
      }));
      expect(createSessionGoal.mock.invocationCallOrder[0]).toBeLessThan(sessionCommandMock.mock.invocationCallOrder[0]);
      expect(response.body).toMatchObject({ goalEnabled: true, dispatchedAsCommand: true });
      expect(globalThis.fetch.mock.calls.some(([url]) => String(url).includes('/prompt_async'))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reuses the previous session selection when send omits model, agent, and variant', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url) => selectionInputResponse(url) || { ok: true, text: async () => '' });
    globalThis.fetch = fetchMock;
    try {
      setSessionMessages([
          {
            info: {
              id: 'msg_user',
              role: 'user',
              agent: 'plan',
              model: { providerID: 'anthropic', modelID: 'claude-sonnet-5', variant: 'high' },
              time: { created: 5 },
            },
          },
          { info: { id: 'msg_before', role: 'assistant', time: { created: 10, completed: 20 } } },
      ]);
      const { app } = createApp();
      const response = await request(app)
        .post('/api/openchamber/sessions/ses_source/send')
        .send({ directory: '/repo/app', prompt: 'Continue where you left off' })
        .expect(200);

      expect(response.body).toMatchObject({
        action: 'send',
        sessionId: 'ses_source',
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-5' },
        agent: 'plan',
        variant: 'high',
        promptDispatched: true,
      });
      const promptCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/prompt_async'));
      const promptBody = JSON.parse(promptCall[1].body);
      expect(promptBody).toMatchObject({
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-5' },
        agent: 'plan',
        variant: 'high',
      });
      // The default-selection inputs (config/providers/agents) must not be consulted.
      expect(fetchMock.mock.calls.every(([url]) => String(url).includes('/prompt_async'))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses the canonical fork directory for prompt history, dispatch, and events', async () => {
    const originalFetch = globalThis.fetch;
    const emitSessionCreatedEvent = vi.fn();
    sessionForkMock.mockResolvedValueOnce({
      data: { id: 'ses_fork', directory: '/canonical/forks/ses_fork', title: 'Forked session' },
    });
    globalThis.fetch = vi.fn(async (url) => selectionInputResponse(url) || { ok: true, text: async () => '' });
    try {
      const { app } = createApp({ emitSessionCreatedEvent });
      const response = await request(app)
        .post('/api/openchamber/sessions/ses_source/fork')
        .send({
          directory: '/repo/app',
          messageId: 'msg_branch_point',
          prompt: 'Try the alternative implementation',
          model: 'openai/gpt-5.5',
          agent: 'build',
          variant: 'high',
        })
        .expect(200);

      expect(sessionForkMock).toHaveBeenCalledWith({
        sessionID: 'ses_source',
        directory: '/repo/app',
        messageID: 'msg_branch_point',
      });
      expect(response.body).toMatchObject({
        action: 'fork',
        sourceSessionId: 'ses_source',
        sessionId: 'ses_fork',
        directory: '/canonical/forks/ses_fork',
        promptDispatched: true,
      });
      expect(sessionMessagesMock).toHaveBeenCalledWith({
        sessionID: 'ses_fork',
        directory: '/canonical/forks/ses_fork',
        limit: 100,
      }, { signal: expect.any(AbortSignal) });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://opencode.test/session/ses_fork/prompt_async?directory=%2Fcanonical%2Fforks%2Fses_fork',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(emitSessionCreatedEvent).toHaveBeenCalledWith(expect.objectContaining({
        sessionID: 'ses_fork',
        sourceSessionID: 'ses_source',
        directory: '/canonical/forks/ses_fork',
        promptDispatched: true,
      }));
      expect(sessionUpdateMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('retains an exact child with unknown directory without probing the source directory', async () => {
    const originalFetch = globalThis.fetch;
    const childSessionID = 'ses_fork_without_directory';
    sessionForkMock.mockResolvedValueOnce({
      data: { id: childSessionID, title: 'Forked session' },
    });
    globalThis.fetch = vi.fn(async (url) => selectionInputResponse(url) || { ok: true, text: async () => '' });
    try {
      const { app } = createApp();
      const response = await request(app)
        .post('/api/openchamber/sessions/ses_source/fork')
        .send({
          directory: '/repo/app',
          prompt: 'Try the alternative implementation',
          model: 'openai/gpt-5.5',
          agent: 'build',
        })
        .expect(502);

      expect(response.body).toEqual({
        error: 'Fork session did not return an authoritative session directory',
        partial: true,
        partialAction: 'fork-retained',
        sessionId: childSessionID,
        recovery: {
          fork: {
            confirmed: false,
            detail: 'forked session did not return an authoritative directory',
          },
        },
      });
      expect(sessionDeleteMock).not.toHaveBeenCalled();
      expect(sessionGetMock.mock.calls.some(([input]) => input.sessionID === childSessionID)).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('preserves a proven OMP backend on the fork before prompt dispatch', async () => {
    const originalFetch = globalThis.fetch;
    const events = [];
    sessionForkMock.mockImplementationOnce(async () => {
      events.push('fork');
      return { data: { id: 'ses_fork', directory: '/repo/app', title: 'Forked session' } };
    });
    sessionGetMock
      .mockImplementationOnce(async ({ sessionID }) => ({
        data: { id: sessionID, metadata: { openchamber: { agent_backend: 'omp' } } },
      }))
      .mockImplementationOnce(async ({ sessionID }) => ({
        data: { id: sessionID, metadata: { openchamber: { agent_backend: 'omp' } } },
      }))
      .mockImplementationOnce(async ({ sessionID }) => ({
        data: { id: sessionID, metadata: { keep: true, openchamber: { inherited: true } } },
      }));
    sessionUpdateMock.mockImplementationOnce(async ({ sessionID, metadata }) => {
      events.push('update');
      return { data: { id: sessionID, title: 'Forked session', metadata } };
    });
    const fetchMock = vi.fn(async (url) => {
      const text = String(url);
      if (text.includes('/config/providers')) events.push('resolve');
      if (text.includes('/prompt_async')) events.push('prompt');
      return selectionInputResponse(url) || { ok: true, text: async () => '' };
    });
    globalThis.fetch = fetchMock;
    try {
      const { app } = createApp();
      const response = await request(app)
        .post('/api/openchamber/sessions/ses_source/fork')
        .send({
          directory: '/repo/app',
          prompt: 'Try another OMP branch',
          model: 'omp/gpt-5.5',
          agent: 'build',
        })
        .expect(200);

      expect(response.body.model).toEqual({ providerID: 'omp', modelID: 'gpt-5.5' });
      expect(sessionUpdateMock).toHaveBeenCalledWith({
        sessionID: 'ses_fork',
        directory: '/repo/app',
        metadata: {
          keep: true,
          openchamber: { inherited: true, agent_backend: 'omp' },
        },
      });
      expect(events.indexOf('resolve')).toBeLessThan(events.indexOf('fork'));
      expect(events.indexOf('fork')).toBeLessThan(events.indexOf('update'));
      expect(events.indexOf('update')).toBeLessThan(events.indexOf('prompt'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects a Pi fork target before calling session.fork', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => selectionInputResponse(url) || { ok: true, text: async () => '' });
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/openchamber/sessions/ses_source/fork')
        .send({
          directory: '/repo/app',
          prompt: 'Try Pi here',
          model: 'pi/anthropic/claude-sonnet-4-5',
          agent: 'build',
        })
        .expect(409, {
          error: 'Pi sessions cannot be created by forking because startup dialogs require an interactive client',
        });

      expect(sessionForkMock).not.toHaveBeenCalled();
      expect(sessionUpdateMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects an OMP-to-native fork conversion before calling session.fork', async () => {
    const originalFetch = globalThis.fetch;
    sessionGetMock.mockImplementation(async ({ sessionID }) => ({
      data: { id: sessionID, metadata: { openchamber: { agent_backend: 'omp' } } },
    }));
    globalThis.fetch = vi.fn(async (url) => selectionInputResponse(url) || { ok: true, text: async () => '' });
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/openchamber/sessions/ses_source/fork')
        .send({ directory: '/repo/app', prompt: 'Try native', model: 'openai/gpt-5.5', agent: 'build' })
        .expect(409, { error: 'Session backend cannot be changed by forking' });

      expect(sessionForkMock).not.toHaveBeenCalled();
      expect(sessionUpdateMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('backfills a legacy OMP source and preserves OMP on its fork', async () => {
    const originalFetch = globalThis.fetch;
    setSessionMessages([{
      info: { id: 'legacy-omp', role: 'assistant', model: { providerID: 'omp' } },
    }]);
    globalThis.fetch = vi.fn(async (url) => selectionInputResponse(url) || { ok: true, text: async () => '' });
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/openchamber/sessions/ses_source/fork')
        .send({ directory: '/repo/app', prompt: 'Continue in OMP', model: 'omp/gpt-5.5', agent: 'build' })
        .expect(200);

      expect(sessionUpdateMock).toHaveBeenNthCalledWith(1, {
        sessionID: 'ses_source',
        directory: '/repo/app',
        metadata: { openchamber: { agent_backend: 'omp' } },
      });
      expect(sessionUpdateMock).toHaveBeenNthCalledWith(2, {
        sessionID: 'ses_fork',
        directory: '/repo/app',
        metadata: { openchamber: { agent_backend: 'omp' } },
      });
      expect(sessionForkMock).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects managed Pi sources before calling session.fork', async () => {
    const originalFetch = globalThis.fetch;
    sessionGetMock.mockImplementation(async ({ sessionID }) => ({
      data: { id: sessionID, metadata: { openchamber: { agent_backend: 'pi' } } },
    }));
    globalThis.fetch = vi.fn(async (url) => selectionInputResponse(url) || { ok: true, text: async () => '' });
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/openchamber/sessions/ses_source/fork')
        .send({
          directory: '/repo/app',
          prompt: 'Try another branch',
          model: 'openai/gpt-5.5',
          agent: 'build',
        })
        .expect(409, { error: 'Pi sessions cannot be forked' });

      expect(sessionForkMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });


  it('backfills and rejects an unmarked legacy Pi source before calling session.fork', async () => {
    const originalFetch = globalThis.fetch;
    sessionMessagesMock.mockResolvedValue({
      data: [{ info: { id: 'legacy-pi', role: 'assistant', model: { providerID: 'pi' } } }],
    });
    globalThis.fetch = vi.fn(async (url) => selectionInputResponse(url) || { ok: true, text: async () => '' });
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/openchamber/sessions/ses_source/fork')
        .send({ directory: '/repo/app', prompt: 'Try another branch', model: 'openai/gpt-5.5', agent: 'build' })
        .expect(409, { error: 'Pi sessions cannot be forked' });

      expect(sessionUpdateMock).toHaveBeenCalledWith({
        sessionID: 'ses_source',
        directory: '/repo/app',
        metadata: { openchamber: { agent_backend: 'pi' } },
      });
      expect(sessionForkMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('pages complete exact Pi history before rejecting a fork', async () => {
    const originalFetch = globalThis.fetch;
    sessionMessagesMock.mockImplementation(async ({ before }) => before
      ? { data: [{ info: { id: 'legacy-pi', role: 'assistant', model: { providerID: 'pi' } } }] }
      : {
        data: [{ info: { id: 'recent-pi', role: 'assistant', model: { providerID: 'pi' } } }],
        response: { headers: new Headers({ 'x-next-cursor': 'older-history' }) },
      });
    globalThis.fetch = vi.fn(async (url) => selectionInputResponse(url) || { ok: true, text: async () => '' });
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/openchamber/sessions/ses_source/fork')
        .send({ directory: '/repo/app', prompt: 'Try another branch', model: 'openai/gpt-5.5', agent: 'build' })
        .expect(409, { error: 'Pi sessions cannot be forked' });

      expect(sessionMessagesMock).toHaveBeenNthCalledWith(1, {
        sessionID: 'ses_source', directory: '/repo/app', limit: 100,
      }, { signal: expect.any(AbortSignal) });
      expect(sessionMessagesMock).toHaveBeenNthCalledWith(2, {
        sessionID: 'ses_source', directory: '/repo/app', limit: 100, before: 'older-history',
      }, { signal: expect.any(AbortSignal) });
      expect(sessionUpdateMock).toHaveBeenCalledWith({
        sessionID: 'ses_source',
        directory: '/repo/app',
        metadata: { openchamber: { agent_backend: 'pi' } },
      });
      expect(sessionForkMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects native and managed backend classes across complete fork history', async () => {
    const originalFetch = globalThis.fetch;
    sessionMessagesMock.mockImplementation(async ({ before }) => before
      ? { data: [{ info: { id: 'legacy-omp', role: 'assistant', model: { providerID: 'omp' } } }] }
      : {
        data: [{ info: { id: 'recent-openai', role: 'assistant', model: { providerID: 'openai' } } }],
        response: { headers: new Headers({ 'x-next-cursor': 'older-history' }) },
      });
    globalThis.fetch = vi.fn(async (url) => selectionInputResponse(url) || { ok: true, text: async () => '' });
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/openchamber/sessions/ses_source/fork')
        .send({ directory: '/repo/app', prompt: 'Try another branch', model: 'openai/gpt-5.5', agent: 'build' })
        .expect(409, { error: 'Mixed native/Pi/OMP session backend history cannot be used' });

      expect(sessionMessagesMock).toHaveBeenCalledTimes(2);
      expect(sessionUpdateMock).not.toHaveBeenCalled();
      expect(sessionForkMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails closed when a later source-history page cannot be read', async () => {
    const originalFetch = globalThis.fetch;
    sessionMessagesMock.mockImplementation(async ({ before }) => {
      if (before) throw new Error('older history unavailable');
      return {
        data: [{ info: { id: 'recent-openai', role: 'assistant', model: { providerID: 'openai' } } }],
        response: { headers: new Headers({ 'x-next-cursor': 'older-history' }) },
      };
    });
    globalThis.fetch = vi.fn(async (url) => selectionInputResponse(url) || { ok: true, text: async () => '' });
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/openchamber/sessions/ses_source/fork')
        .send({ directory: '/repo/app', prompt: 'Try another branch', model: 'openai/gpt-5.5', agent: 'build' })
        .expect(500, { error: 'older history unavailable' });

      expect(sessionMessagesMock).toHaveBeenCalledTimes(2);
      expect(sessionUpdateMock).not.toHaveBeenCalled();
      expect(sessionForkMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects mixed Pi/OMP providers across legacy history before a fork', async () => {
    const originalFetch = globalThis.fetch;
    sessionMessagesMock.mockImplementation(async ({ before }) => before
      ? { data: [{ info: { id: 'legacy-omp', role: 'assistant', model: { providerID: 'omp' } } }] }
      : {
        data: [{ info: { id: 'recent-pi', role: 'assistant', model: { providerID: 'pi' } } }],
        response: { headers: new Headers({ 'x-next-cursor': 'older-history' }) },
      });
    globalThis.fetch = vi.fn(async (url) => selectionInputResponse(url) || { ok: true, text: async () => '' });
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/openchamber/sessions/ses_source/fork')
        .send({ directory: '/repo/app', prompt: 'Try another branch', model: 'openai/gpt-5.5', agent: 'build' })
        .expect(409, { error: 'Mixed native/Pi/OMP session backend history cannot be used' });

      expect(sessionMessagesMock).toHaveBeenNthCalledWith(1, {
        sessionID: 'ses_source', directory: '/repo/app', limit: 100,
      }, { signal: expect.any(AbortSignal) });
      expect(sessionMessagesMock).toHaveBeenNthCalledWith(2, {
        sessionID: 'ses_source', directory: '/repo/app', limit: 100, before: 'older-history',
      }, { signal: expect.any(AbortSignal) });
      expect(sessionUpdateMock).not.toHaveBeenCalled();
      expect(sessionForkMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects mixed Pi/OMP legacy history before a send can stamp or dispatch', async () => {
    const originalFetch = globalThis.fetch;
    sessionMessagesMock.mockResolvedValue({
      data: [
        { info: { id: 'legacy-pi', role: 'assistant', model: { providerID: 'pi' } } },
        { info: { id: 'legacy-omp', role: 'assistant', model: { providerID: 'omp' } } },
      ],
    });
    globalThis.fetch = vi.fn(async (url) => selectionInputResponse(url) || { ok: true, text: async () => '' });
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/openchamber/sessions/ses_source/send')
        .send({ directory: '/repo/app', prompt: 'Continue', model: 'pi/anthropic/claude-sonnet-4-5', agent: 'build' })
        .expect(409, { error: 'Mixed native/Pi/OMP session backend history cannot be used' });

      expect(sessionUpdateMock).not.toHaveBeenCalled();
      expect(globalThis.fetch.mock.calls.some(([url]) => String(url).includes('/prompt_async'))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects native and managed history before a send can stamp or dispatch', async () => {
    const originalFetch = globalThis.fetch;
    setSessionMessages([
      { info: { id: 'native-openai', role: 'assistant', model: { providerID: 'openai' } } },
      { info: { id: 'managed-omp', role: 'assistant', model: { providerID: 'omp' } } },
    ]);
    globalThis.fetch = vi.fn(async (url) => selectionInputResponse(url) || { ok: true, text: async () => '' });
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/openchamber/sessions/ses_source/send')
        .send({ directory: '/repo/app', prompt: 'Continue', model: 'omp/gpt-5.5', agent: 'build' })
        .expect(409, { error: 'Mixed native/Pi/OMP session backend history cannot be used' });

      expect(sessionUpdateMock).not.toHaveBeenCalled();
      expect(globalThis.fetch.mock.calls.some(([url]) => String(url).includes('/prompt_async'))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it.each([
    'pi/anthropic/claude-sonnet-4-5',
    'omp/gpt-5.5',
  ])('does not stamp a native session from requested managed provider %s', async (model) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => selectionInputResponse(url) || { ok: true, text: async () => '' });
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/openchamber/sessions/ses_source/send')
        .send({ directory: '/repo/app', prompt: 'Continue', model, agent: 'build' })
        .expect(409, {
          error: 'Native sessions cannot be converted to a managed Pi/OMP backend by sending a prompt',
        });

      expect(sessionUpdateMock).not.toHaveBeenCalled();
      expect(globalThis.fetch.mock.calls.some(([url]) => String(url).includes('/prompt_async'))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('backfills a legacy Pi marker from history before dispatching a Pi prompt', async () => {
    const originalFetch = globalThis.fetch;
    setSessionMessages([{
      info: { id: 'legacy-pi', role: 'assistant', model: { providerID: 'pi' } },
    }]);
    globalThis.fetch = vi.fn(async (url) => selectionInputResponse(url) || { ok: true, text: async () => '' });
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/openchamber/sessions/ses_source/send')
        .send({
          directory: '/repo/app',
          prompt: 'Continue in Pi',
          model: 'pi/anthropic/claude-sonnet-4-5',
          agent: 'build',
        })
        .expect(200);

      expect(sessionUpdateMock).toHaveBeenCalledWith({
        sessionID: 'ses_source',
        directory: '/repo/app',
        metadata: { openchamber: { agent_backend: 'pi' } },
      });
      expect(globalThis.fetch.mock.calls.some(([url]) => String(url).includes('/prompt_async'))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('authorizes native sends without stamping managed metadata', async () => {
    setSessionMessages([
      { info: { id: 'native-openai', role: 'assistant', model: { providerID: 'openai' } } },
      { info: { id: 'native-anthropic', role: 'assistant', model: { providerID: 'anthropic' } } },
    ]);
    const { app } = createApp();
    await request(app)
      .post('/api/openchamber/sessions/ses_source/send-preflight')
      .send({ directory: '/repo/app', providerID: 'openai' })
      .expect(200, { authorized: true });

    expect(sessionUpdateMock).not.toHaveBeenCalled();
  });

  it.each(['pi', 'omp'])('rejects native-to-%s sends during preflight', async (providerID) => {
    const { app } = createApp();
    await request(app)
      .post('/api/openchamber/sessions/ses_source/send-preflight')
      .send({ directory: '/repo/app', providerID })
      .expect(409, {
        error: 'Native sessions cannot be converted to a managed Pi/OMP backend by sending a prompt',
      });

    expect(sessionUpdateMock).not.toHaveBeenCalled();
  });

  it.each([
    ['pi', 'omp'],
    ['omp', 'pi'],
  ])('rejects a %s-to-%s managed backend change during preflight', async (existing, requested) => {
    sessionGetMock.mockImplementation(async ({ sessionID }) => ({
      data: { id: sessionID, metadata: { openchamber: { agent_backend: existing } } },
    }));
    const { app } = createApp();
    await request(app)
      .post('/api/openchamber/sessions/ses_source/send-preflight')
      .send({ directory: '/repo/app', providerID: requested })
      .expect(409, { error: 'Managed Pi/OMP session backend cannot be changed' });

    expect(sessionUpdateMock).not.toHaveBeenCalled();
  });

  it('backfills a proven legacy OMP backend during preflight', async () => {
    setSessionMessages([{
      info: { id: 'legacy-omp', role: 'assistant', model: { providerID: 'omp' } },
    }]);
    const { app } = createApp();
    await request(app)
      .post('/api/openchamber/sessions/ses_source/send-preflight')
      .send({ directory: '/repo/app', providerID: 'omp' })
      .expect(200, { authorized: true });

    expect(sessionUpdateMock).toHaveBeenCalledWith({
      sessionID: 'ses_source',
      directory: '/repo/app',
      metadata: { openchamber: { agent_backend: 'omp' } },
    });
  });

  it('fails preflight closed when a later history page cannot be read', async () => {
    sessionMessagesMock.mockImplementation(async ({ before }) => {
      if (before) throw new Error('older history unavailable');
      return {
        data: [{ info: { id: 'recent-openai', role: 'assistant', model: { providerID: 'openai' } } }],
        response: { headers: new Headers({ 'x-next-cursor': 'older-history' }) },
      };
    });
    const { app } = createApp();
    await request(app)
      .post('/api/openchamber/sessions/ses_source/send-preflight')
      .send({ directory: '/repo/app', providerID: 'openai' })
      .expect(500, { error: 'older history unavailable' });

    expect(sessionMessagesMock).toHaveBeenCalledTimes(2);
    expect(sessionUpdateMock).not.toHaveBeenCalled();
  });

  it('rejects review-marked sources before reading history or forking', async () => {
    const originalFetch = globalThis.fetch;
    sessionGetMock.mockResolvedValueOnce({
      data: { id: 'ses_source', metadata: { openchamber: { kind: 'review', originalSessionID: 'ses_original' } } },
    });
    globalThis.fetch = vi.fn(async (url) => selectionInputResponse(url) || { ok: true, text: async () => '' });
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/openchamber/sessions/ses_source/fork')
        .send({ directory: '/repo/app', prompt: 'Try another branch', model: 'openai/gpt-5.5', agent: 'build' })
        .expect(409, { error: 'Review sessions cannot be forked' });

      expect(sessionMessagesMock).not.toHaveBeenCalled();
      expect(sessionForkMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('re-reads current metadata before backfilling a legacy managed marker', async () => {
    const originalFetch = globalThis.fetch;
    sessionGetMock
      .mockResolvedValueOnce({ data: { id: 'ses_source', metadata: { stale: true } } })
      .mockResolvedValueOnce({ data: { id: 'ses_source', metadata: { keep: true, openchamber: { goal: { id: 'goal' } } } } });
    sessionMessagesMock.mockResolvedValue({
      data: [{ info: { id: 'legacy-pi', role: 'assistant', model: { providerID: 'pi' } } }],
    });
    globalThis.fetch = vi.fn(async (url) => selectionInputResponse(url) || { ok: true, text: async () => '' });
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/openchamber/sessions/ses_source/fork')
        .send({ directory: '/repo/app', prompt: 'Try another branch', model: 'openai/gpt-5.5', agent: 'build' })
        .expect(409, { error: 'Pi sessions cannot be forked' });

      expect(sessionUpdateMock).toHaveBeenCalledWith({
        sessionID: 'ses_source',
        directory: '/repo/app',
        metadata: { keep: true, openchamber: { goal: { id: 'goal' }, agent_backend: 'pi' } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails closed when source history cannot be read before a fork', async () => {
    const originalFetch = globalThis.fetch;
    sessionMessagesMock.mockRejectedValue(new Error('history unavailable'));
    globalThis.fetch = vi.fn(async (url) => selectionInputResponse(url) || { ok: true, text: async () => '' });
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/openchamber/sessions/ses_source/fork')
        .send({ directory: '/repo/app', prompt: 'Try another branch', model: 'openai/gpt-5.5', agent: 'build' })
        .expect(500, { error: 'history unavailable' });

      expect(sessionForkMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects send and fork requests without a prompt before calling OpenCode', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/openchamber/sessions/ses_source/send')
        .send({ directory: '/repo/app' })
        .expect(400, { error: 'prompt is required' });
      await request(app)
        .post('/api/openchamber/sessions/ses_source/fork')
        .send({ directory: '/repo/app' })
        .expect(400, { error: 'prompt is required' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(sessionForkMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('compensates a fork that completes after its caller cancels before dispatch', async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    sessionForkMock.mockImplementationOnce(async () => {
      controller.abort();
      return { data: { id: 'ses_fork', directory: '/canonical/forks/ses_fork', title: 'Forked session' } };
    });
    sessionGetMock.mockImplementation(async ({ sessionID }) => (
      sessionID === 'ses_fork'
        ? { response: { status: 404 } }
        : { data: { id: sessionID, metadata: {} } }
    ));
    globalThis.fetch = vi.fn(async (url) => selectionInputResponse(url) || { ok: true, text: async () => '' });
    try {
      const service = createSessionService();
      await expect(service.fork('ses_source', {
        directory: '/repo/app',
        prompt: 'Try another approach',
        model: 'openai/gpt-5.5',
        agent: 'build',
      }, { signal: controller.signal })).rejects.toMatchObject({ statusCode: 499 });

      expect(sessionDeleteMock).toHaveBeenCalledWith({
        sessionID: 'ses_fork',
        directory: '/canonical/forks/ses_fork',
      }, expect.any(Object));
      expect(sessionGetMock).toHaveBeenLastCalledWith({
        sessionID: 'ses_fork',
        directory: '/canonical/forks/ses_fork',
      }, expect.any(Object));
      expect(globalThis.fetch.mock.calls.some(([url]) => String(url).includes('/prompt_async'))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports the forked session when prompt dispatch fails', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => selectionInputResponse(url) || { ok: false, status: 500, text: async () => 'dispatch failed' });
    try {
      const { app } = createApp();
      const response = await request(app)
        .post('/api/openchamber/sessions/ses_source/fork')
        .send({
          directory: '/repo/app',
          prompt: 'Try another approach',
          model: 'openai/gpt-5.5',
          agent: 'build',
          variant: 'high',
        })
        .expect(500);

      expect(response.body).toMatchObject({
        partial: true,
        partialAction: 'fork-retained',
        sessionId: 'ses_fork',
        directory: '/repo/app',
        recovery: { fork: { confirmed: false } },
      });
      expect(sessionDeleteMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not apply a default variant to an explicitly requested model', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url) => {
      const text = String(url);
      if (text.includes('/prompt_async')) return { ok: true, text: async () => '' };
      if (text.includes('/config/providers')) {
        return {
          ok: true,
          json: async () => ({
            providers: [
              { id: 'openai', models: { requested: { id: 'requested' }, default: { id: 'default', variants: { high: {} } } } },
            ],
          }),
        };
      }
      if (text.includes('/agent')) return { ok: true, json: async () => [{ name: 'build', mode: 'primary' }] };
      if (text.includes('/config')) return { ok: true, json: async () => ({}) };
      return { ok: true, json: async () => createdSessionResponse(url) };
    });
    globalThis.fetch = fetchMock;
    try {
      const { app } = createApp({
        readSettingsFromDiskMigrated: async () => ({
          defaultModel: 'openai/default',
          defaultVariant: 'high',
          projects: [{ id: 'proj_1', path: '/repo/app' }],
        }),
      });
      await request(app)
        .post('/api/openchamber/sessions/ses_source/send')
        .send({ directory: '/repo/app', prompt: 'Continue', model: 'openai/requested', agent: 'build' })
        .expect(200);

      const promptCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/prompt_async'));
      expect(JSON.parse(promptCall[1].body)).not.toHaveProperty('variant');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('validates an unknown agent against the bootstrapped worktree and compensates it', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url) => selectionInputResponse(url) || { ok: true, json: async () => createdSessionResponse(url) });
    globalThis.fetch = fetchMock;
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/openchamber/sessions')
        .send({
          directory: '/repo/app',
          prompt: 'Run this',
          agent: 'not-an-agent',
          worktree: { name: 'side-task' },
        })
        .expect(400, { error: "Unknown agent 'not-an-agent' for /repo/worktrees/side-task" });

      expect(createWorktreeMock).toHaveBeenCalledOnce();
      expect(removeWorktreeMock).toHaveBeenCalledWith('/repo/app', {
        directory: '/repo/worktrees/side-task',
        deleteLocalBranch: true,
        expectedBranch: 'openchamber/side-task',
        requireClean: true,
      });
      expect(fetchMock.mock.calls.some(([url]) => String(url) === 'http://opencode.test/session?directory=%2Frepo%2Fworktrees%2Fside-task')).toBe(false);
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/prompt_async'))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('cancels worktree provisioning, stops bootstrap, and rolls back the created worktree', async () => {
    const controller = new AbortController();
    getWorktreeBootstrapStatusMock.mockImplementation(async () => {
      controller.abort();
      return {
        status: 'pending',
        phase: 'git-ready',
        error: null,
        updatedAt: Date.now(),
      };
    });
    const service = createSessionService();

    await expect(service.create({
      directory: '/repo/app',
      worktree: { name: 'side-task' },
    }, { signal: controller.signal })).rejects.toMatchObject({ statusCode: 499 });

    expect(cancelWorktreeBootstrapMock).toHaveBeenCalledWith('/repo/worktrees/side-task', 5_000);
    expect(removeWorktreeMock).toHaveBeenCalledWith('/repo/app', {
      directory: '/repo/worktrees/side-task',
      deleteLocalBranch: true,
      expectedBranch: 'openchamber/side-task',
      requireClean: true,
    });
  });

  it('retains a new session and worktree when prompt dispatch races cancellation', async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('/prompt_async')) {
        controller.abort();
        return { ok: true, text: async () => '' };
      }
      return selectionInputResponse(url) || { ok: true, json: async () => createdSessionResponse(url) };
    });
    try {
      const service = createSessionService();
      await expect(service.create({
        directory: '/repo/app',
        prompt: 'Run this',
        model: 'openai/gpt-5.5',
        worktree: { name: 'side-task' },
      }, { signal: controller.signal })).rejects.toMatchObject({
        statusCode: 499,
        partial: true,
        partialAction: 'session-worktree-retained',
        sessionId: 'ses_123',
        directory: '/repo/worktrees/side-task',
        recovery: { dispatch: { started: true } },
      });

      expect(sessionDeleteMock).not.toHaveBeenCalled();
      expect(cancelWorktreeBootstrapMock).not.toHaveBeenCalled();
      expect(removeWorktreeMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('retains a new session and worktree when command dispatch races cancellation', async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    commandListMock.mockResolvedValue({ data: [{ name: 'issue--to-pr', template: 'Handle $ARGUMENTS.' }] });
    sessionCommandMock.mockImplementation(async () => {
      controller.abort();
      return { data: {} };
    });
    globalThis.fetch = vi.fn(async (url) => selectionInputResponse(url) || { ok: true, json: async () => createdSessionResponse(url) });
    try {
      const service = createSessionService();
      await expect(service.create({
        directory: '/repo/app',
        prompt: '/issue--to-pr OC-123',
        model: 'openai/gpt-5.5',
        worktree: { name: 'side-task' },
      }, { signal: controller.signal })).rejects.toMatchObject({
        statusCode: 499,
        partial: true,
        partialAction: 'session-worktree-retained',
        sessionId: 'ses_123',
        directory: '/repo/worktrees/side-task',
        recovery: { dispatch: { started: true } },
      });

      expect(sessionDeleteMock).not.toHaveBeenCalled();
      expect(cancelWorktreeBootstrapMock).not.toHaveBeenCalled();
      expect(removeWorktreeMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('confirms new-session cleanup before removing its worktree after goal setup fails', async () => {
    const originalFetch = globalThis.fetch;
    const createSessionGoal = vi.fn(async () => {
      throw new Error('goal setup failed');
    });
    sessionGetMock.mockResolvedValueOnce({ error: { message: 'not found' }, response: { status: 404 } });
    globalThis.fetch = vi.fn(async (url) => selectionInputResponse(url) || {
      ok: true,
      json: async () => ({ id: 'ses_123', directory: '/canonical/worktrees/side-task' }),
    });
    try {
      const { app } = createApp({ createSessionGoal });
      await request(app)
        .post('/api/openchamber/sessions')
        .send({
          directory: '/repo/app',
          prompt: 'Run this',
          model: 'openai/gpt-5.5',
          goal: true,
          worktree: { name: 'side-task' },
        })
        .expect(500);

      expect(sessionDeleteMock).toHaveBeenCalledWith({
        sessionID: 'ses_123',
        directory: '/canonical/worktrees/side-task',
      }, expect.any(Object));
      expect(sessionDeleteMock.mock.invocationCallOrder[0]).toBeLessThan(removeWorktreeMock.mock.invocationCallOrder[0]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('bounds compensating session cleanup requests after a failed provision', async () => {
    const originalFetch = globalThis.fetch;
    const expiredDeadline = new AbortController();
    expiredDeadline.abort();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(expiredDeadline.signal);
    const createSessionGoal = vi.fn(async () => {
      throw new Error('goal setup failed');
    });
    sessionDeleteMock.mockImplementation(async (_input, options) => {
      expect(options.signal).toBe(expiredDeadline.signal);
      throw new Error('cleanup delete deadline elapsed');
    });
    sessionGetMock.mockImplementation(async (_input, options) => {
      expect(options.signal).toBe(expiredDeadline.signal);
      throw new Error('cleanup verification deadline elapsed');
    });
    globalThis.fetch = vi.fn(async (url) => selectionInputResponse(url) || { ok: true, json: async () => createdSessionResponse(url) });
    try {
      const { app } = createApp({ createSessionGoal });
      const response = await request(app)
        .post('/api/openchamber/sessions')
        .send({
          directory: '/repo/app',
          prompt: 'Run this',
          model: 'openai/gpt-5.5',
          goal: true,
          worktree: { name: 'side-task' },
        })
        .expect(500);

      expect(response.body).toMatchObject({
        partial: true,
        partialAction: 'session-worktree-recovery-required',
        sessionId: 'ses_123',
      });
      expect(timeoutSpy).toHaveBeenCalledTimes(2);
      expect(removeWorktreeMock).not.toHaveBeenCalled();
    } finally {
      timeoutSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  it('retains both resources with recovery data when new-session cleanup is unconfirmed', async () => {
    const originalFetch = globalThis.fetch;
    const createSessionGoal = vi.fn(async () => {
      throw new Error('goal setup failed');
    });
    sessionGetMock.mockResolvedValueOnce({ data: { id: 'ses_123', metadata: {} } });
    globalThis.fetch = vi.fn(async (url) => selectionInputResponse(url) || { ok: true, json: async () => createdSessionResponse(url) });
    try {
      const { app } = createApp({ createSessionGoal });
      const response = await request(app)
        .post('/api/openchamber/sessions')
        .send({
          directory: '/repo/app',
          prompt: 'Run this',
          model: 'openai/gpt-5.5',
          goal: true,
          worktree: { name: 'side-task' },
        })
        .expect(500);

      expect(response.body).toMatchObject({
        partial: true,
        partialAction: 'session-worktree-recovery-required',
        sessionId: 'ses_123',
        directory: '/repo/worktrees/side-task',
        worktree: { path: '/repo/worktrees/side-task', branch: 'openchamber/side-task' },
      });
      expect(cancelWorktreeBootstrapMock).not.toHaveBeenCalled();
      expect(removeWorktreeMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('retains a worktree when bootstrap cancellation cannot prove it clean', async () => {
    const originalFetch = globalThis.fetch;
    cancelWorktreeBootstrapMock.mockResolvedValue({
      settled: false,
      attached: true,
      branch: 'openchamber/side-task',
      clean: false,
      safeToRemove: false,
      bootstrapStatus: { status: 'pending', phase: 'setup-running' },
    });
    globalThis.fetch = vi.fn(async (url) => selectionInputResponse(url) || { ok: true, json: async () => createdSessionResponse(url) });
    try {
      const { app } = createApp();
      const response = await request(app)
        .post('/api/openchamber/sessions')
        .send({
          directory: '/repo/app',
          prompt: 'Run this',
          agent: 'not-an-agent',
          worktree: { name: 'side-task' },
        })
        .expect(500);

      expect(response.body).toMatchObject({
        partial: true,
        partialAction: 'worktree-retained',
        directory: '/repo/worktrees/side-task',
        worktree: { path: '/repo/worktrees/side-task' },
        recovery: {
          expectedBranch: 'openchamber/side-task',
          bootstrap: { safeToRemove: false, clean: false },
        },
      });
      expect(removeWorktreeMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('retains a worktree when its current tip differs from its creation head', async () => {
    const originalFetch = globalThis.fetch;
    cancelWorktreeBootstrapMock.mockResolvedValue({
      settled: true,
      attached: true,
      branch: 'openchamber/side-task',
      clean: true,
      safeToRemove: true,
      createdHead: 'abc123',
      currentHead: 'def456',
      bootstrapStatus: { status: 'ready', phase: 'setup-ready' },
    });
    globalThis.fetch = vi.fn(async (url) => selectionInputResponse(url) || { ok: true, json: async () => createdSessionResponse(url) });
    try {
      const { app } = createApp();
      const response = await request(app)
        .post('/api/openchamber/sessions')
        .send({
          directory: '/repo/app',
          prompt: 'Run this',
          agent: 'not-an-agent',
          worktree: { name: 'side-task' },
        })
        .expect(500);

      expect(response.body).toMatchObject({
        partial: true,
        partialAction: 'worktree-retained',
        recovery: {
          expectedHead: 'abc123',
          bootstrap: { createdHead: 'abc123', currentHead: 'def456' },
        },
      });
      expect(removeWorktreeMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects an unknown model and an unknown variant before dispatching', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url) => selectionInputResponse(url) || { ok: true, json: async () => createdSessionResponse(url) });
    globalThis.fetch = fetchMock;
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/openchamber/sessions')
        .send({ directory: '/repo/app', prompt: 'Run this', model: 'openai/gpt-nope' })
        .expect(400, { error: "Unknown model 'openai/gpt-nope' for /repo/app" });
      await request(app)
        .post('/api/openchamber/sessions')
        .send({ directory: '/repo/app', prompt: 'Run this', model: 'openai/gpt-5.5', variant: 'ultra' })
        .expect(400, { error: "Unknown variant 'ultra' for model 'openai/gpt-5.5'" });

      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/prompt_async'))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports promptDispatched false when the accepted prompt never reaches the session', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('/prompt_async')) return { ok: true, text: async () => '' };
      return selectionInputResponse(url) || { ok: true, json: async () => createdSessionResponse(url) };
    });
    globalThis.fetch = fetchMock;
    sessionMessagesMock.mockResolvedValue({ data: [] });
    try {
      const { app } = createApp();
      const response = await request(app)
        .post('/api/openchamber/sessions')
        .send({ directory: '/repo/app', prompt: 'Run this', model: 'openai/gpt-5.5' })
        .expect(200);

      expect(response.body.sessionId).toBe('ses_123');
      expect(response.body.promptDispatched).toBe(false);
      expect(response.body.promptError).toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 20_000);

  it('does not retry a failed slash command as a normal prompt', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url) => selectionInputResponse(url));
    commandListMock.mockResolvedValue({ data: [{ name: 'review' }] });
    sessionCommandMock.mockRejectedValue(new Error('command response failed'));
    globalThis.fetch = fetchMock;
    try {
      const { app } = createApp();
      await request(app)
        .post('/api/openchamber/sessions/ses_source/send')
        .send({
          directory: '/repo/app',
          prompt: '/review fix this',
          model: 'openai/gpt-5.5',
          agent: 'build',
          variant: 'high',
        })
        .expect(500);

      expect(sessionCommandMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/prompt_async'))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects a native-to-OMP authorized fork before calling session.fork', async () => {
    const { app } = createApp();
    await request(app)
      .post('/api/openchamber/sessions/ses_source/fork-authorized')
      .send({ directory: '/repo/app', providerID: 'omp' })
      .expect(409, { error: 'Session backend cannot be changed by forking' });

    expect(sessionForkMock).not.toHaveBeenCalled();
    expect(sessionUpdateMock).not.toHaveBeenCalled();
  });

  it('stamps an authorized OMP fork in its canonical child directory', async () => {
    sessionForkMock.mockResolvedValueOnce({
      data: { id: 'ses_fork', directory: '/canonical/forks/ses_fork', title: 'Forked session' },
    });
    sessionGetMock.mockImplementation(async ({ sessionID, directory }) => ({
      data: {
        id: sessionID,
        directory,
        metadata: sessionID === 'ses_source' ? { openchamber: { agent_backend: 'omp' } } : {},
      },
    }));
    const { app } = createApp();
    const response = await request(app)
      .post('/api/openchamber/sessions/ses_source/fork-authorized')
      .send({ directory: '/repo/app', providerID: 'omp' })
      .expect(200);

    expect(sessionForkMock).toHaveBeenCalledWith({
      sessionID: 'ses_source',
      directory: '/repo/app',
      messageID: undefined,
    });
    expect(sessionUpdateMock).toHaveBeenCalledWith({
      sessionID: 'ses_fork',
      directory: '/canonical/forks/ses_fork',
      metadata: { openchamber: { agent_backend: 'omp' } },
    });
    expect(response.body).toMatchObject({
      directory: '/canonical/forks/ses_fork',
      session: { id: 'ses_fork', directory: '/canonical/forks/ses_fork' },
    });
  });

  it('retains an authorized child with unknown directory without probing the source directory', async () => {
    const childSessionID = 'ses_authorized_fork_without_directory';
    sessionForkMock.mockResolvedValueOnce({ data: { id: childSessionID } });
    const { app } = createApp();
    const response = await request(app)
      .post('/api/openchamber/sessions/ses_source/fork-authorized')
      .send({ directory: '/repo/app', providerID: 'openai' })
      .expect(502);

    expect(response.body).toEqual({
      error: 'Fork session did not return an authoritative session directory',
      partial: true,
      partialAction: 'fork-retained',
      sessionId: childSessionID,
      recovery: {
        fork: {
          confirmed: false,
          detail: 'forked session did not return an authoritative directory',
        },
      },
    });
    expect(sessionDeleteMock).not.toHaveBeenCalled();
    expect(sessionGetMock.mock.calls.some(([input]) => input.sessionID === childSessionID)).toBe(false);
  });

  it('rejects a server-authorized fork once a concurrent managed prompt has claimed the source', async () => {
    const originalFetch = globalThis.fetch;
    let source = { id: 'ses_source', metadata: {} };
    setSessionMessages([{
      info: { id: 'legacy-pi', role: 'assistant', model: { providerID: 'pi' } },
    }]);
    let releaseBackendStamp;
    let releaseStampGate;
    const backendStamped = new Promise((resolve) => { releaseBackendStamp = resolve; });
    const stampGate = new Promise((resolve) => { releaseStampGate = resolve; });
    sessionGetMock.mockImplementation(async ({ sessionID }) => ({ data: { ...source, id: sessionID } }));
    sessionUpdateMock.mockImplementation(async ({ metadata }) => {
      source = { ...source, metadata };
      releaseBackendStamp();
      await stampGate;
      return { data: source };
    });
    globalThis.fetch = vi.fn(async (url) => selectionInputResponse(url) || { ok: true, text: async () => '' });
    try {
      const { app } = createApp();
      const send = request(app)
        .post('/api/openchamber/sessions/ses_source/send')
        .send({
          directory: '/repo/app',
          prompt: 'Start a managed turn',
          model: 'pi/anthropic/claude-sonnet-4-5',
          agent: 'build',
        })
        .then((response) => response);

      await backendStamped;
      const fork = request(app)
        .post('/api/openchamber/sessions/ses_source/fork-authorized')
        .send({ directory: '/repo/app', providerID: 'openai' })
        .then((response) => response);
      releaseStampGate();

      const [sendResponse, forkResponse] = await Promise.all([send, fork]);
      expect(sendResponse.status).toBe(200);
      expect(forkResponse.status).toBe(409);
      expect(forkResponse.body).toEqual({ error: 'Pi sessions cannot be forked' });
      expect(sessionForkMock).not.toHaveBeenCalled();
      expect(source.metadata).toEqual({ openchamber: { agent_backend: 'pi' } });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  it('atomically compares and replaces review links for concurrent clients', async () => {
    let source = {
      id: 'ses_source',
      metadata: { openchamber: { reviewSessionID: 'review-old' } },
    };
    sessionGetMock.mockImplementation(async () => ({ data: source }));
    sessionUpdateMock.mockImplementation(async ({ metadata }) => {
      source = { ...source, metadata };
      return { data: source };
    });
    const { app } = createApp();

    const [first, second] = await Promise.all([
      request(app)
        .post('/api/openchamber/sessions/ses_source/review-link')
        .send({ directory: '/repo/app', expectedReviewSessionId: 'review-old', replacementReviewSessionId: 'review-a' }),
      request(app)
        .post('/api/openchamber/sessions/ses_source/review-link')
        .send({ directory: '/repo/app', expectedReviewSessionId: 'review-old', replacementReviewSessionId: 'review-b' }),
    ]);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect([first.body.replaced, second.body.replaced].filter(Boolean)).toHaveLength(1);
    expect(sessionUpdateMock).toHaveBeenCalledTimes(1);
    const winningReviewID = first.body.replaced ? 'review-a' : 'review-b';
    expect(first.body.session.metadata.openchamber.reviewSessionID).toBe(winningReviewID);
    expect(second.body.session.metadata.openchamber.reviewSessionID).toBe(winningReviewID);
    expect(source.metadata.openchamber.reviewSessionID).toBe(winningReviewID);
  });

});
