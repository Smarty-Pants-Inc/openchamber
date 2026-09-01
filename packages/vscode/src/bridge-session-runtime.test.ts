import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { BridgeContext } from './bridge';
import { type SessionRuntimeDeps, tryHandleOpenChamberSessionProxy } from './bridge-session-runtime';

type Session = {
  id: string;
  directory?: string;
  metadata?: Record<string, unknown>;
};

type Message = { info?: { id?: string; providerID?: string; model?: { providerID?: string } } };
type Result<T> = { data?: T; error?: unknown; response?: { status?: number; headers?: Headers } };
type RequestOptions = { signal?: AbortSignal };

type FakeClient = {
  session: {
    get: (input: { sessionID: string; directory: string }, options?: RequestOptions) => Promise<Result<Session>>;
    update: (input: { sessionID: string; directory: string; metadata: Record<string, unknown> }, options?: RequestOptions) => Promise<Result<Session>>;
    messages: (input: { sessionID: string; directory: string; limit: number; before?: string }, options?: RequestOptions) => Promise<Result<Message[]>>;
    fork: (input: { sessionID: string; directory: string; messageID?: string }, options?: RequestOptions) => Promise<Result<Session>>;
    delete: (input: { sessionID: string; directory: string }, options?: RequestOptions) => Promise<Result<boolean>>;
  };
};

const encode = (body: unknown): string => Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
const decode = (bodyText: string): unknown => JSON.parse(bodyText);

const ctx = {
  manager: {
    getOpenCodeAuthHeaders: () => ({ authorization: 'Bearer extension-token' }),
  },
} as unknown as BridgeContext;

const depsFor = (client: FakeClient): SessionRuntimeDeps => ({
  waitForApiUrl: async () => 'http://127.0.0.1:3902',
  createClient: () => client,
});

const createClient = (overrides: Partial<FakeClient['session']> = {}): FakeClient => ({
  session: {
    get: async ({ sessionID }) => ({ data: { id: sessionID, metadata: {} } }),
    update: async ({ sessionID, metadata }) => ({ data: { id: sessionID, metadata } }),
    messages: async () => ({ data: [] }),
    fork: async () => ({ data: { id: 'fork', directory: '/repo', metadata: {} } }),
    delete: async () => ({ data: true }),
    ...overrides,
  },
});

const invoke = (
  client: FakeClient,
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
) => tryHandleOpenChamberSessionProxy(
  path.endsWith('/metadata') ? 'PATCH' : 'POST',
  path,
  encode(body),
  ctx,
  signal,
  depsFor(client),
);

describe('VS Code OpenChamber session bridge', () => {
  test('applies metadata compare-and-swap locally instead of forwarding the OpenChamber route', async () => {
    const session: Session = {
      id: 'source',
      metadata: { keep: true, openchamber: { existing: { id: 'keep' } } },
    };
    const updates: Array<{ sessionID: string; directory: string; metadata: Record<string, unknown> }> = [];
    const client = createClient({
      get: async () => ({ data: session }),
      update: async (input) => {
        updates.push(input);
        session.metadata = input.metadata;
        return { data: session };
      },
    });

    const response = await invoke(client, '/openchamber/sessions/source/metadata', {
      directory: '/repo',
      operations: [{
        type: 'set',
        path: ['openchamber', 'goal'],
        expected: { exists: false },
        value: { id: 'goal-a' },
      }],
    });

    assert.equal(response?.status, 200);
    assert.deepEqual(updates, [{
      sessionID: 'source',
      directory: '/repo',
      metadata: {
        keep: true,
        openchamber: { existing: { id: 'keep' }, goal: { id: 'goal-a' } },
      },
    }]);
    assert.deepEqual(decode(response?.bodyText || '{}'), { session });
  });

  test('rejects an aborted metadata request before SDK dispatch', async () => {
    const controller = new AbortController();
    controller.abort();
    let getCount = 0;
    let updateCount = 0;
    const client = createClient({
      get: async () => {
        getCount += 1;
        return { data: { id: 'source', metadata: {} } };
      },
      update: async () => {
        updateCount += 1;
        return { data: { id: 'source', metadata: {} } };
      },
    });

    const response = await invoke(client, '/openchamber/sessions/source/metadata', {
      directory: '/repo',
      operations: [{
        type: 'set',
        path: ['openchamber', 'goal'],
        expected: { exists: false },
        value: { id: 'goal-a' },
      }],
    }, controller.signal);

    assert.equal(response?.status, 499);
    assert.deepEqual(decode(response?.bodyText || '{}'), { error: 'Request cancelled' });
    assert.equal(getCount, 0);
    assert.equal(updateCount, 0);
  });

  test('scans every page, backfills a legacy OMP source, and keeps fork capability enabled', async () => {
    const source: Session = { id: 'source', metadata: { openchamber: {} } };
    const updates: Record<string, unknown>[] = [];
    const client = createClient({
      get: async () => ({ data: source }),
      update: async (input) => {
        updates.push(input.metadata);
        source.metadata = input.metadata;
        return { data: source };
      },
      messages: async (input) => input.before
        ? { data: [{ info: { id: 'm-omp-older', providerID: 'omp' } }] }
        : {
            data: [{ info: { id: 'm-omp-recent', providerID: 'omp' } }],
            response: { headers: new Headers({ 'x-next-cursor': 'next-page' }) },
          },
    });

    const response = await invoke(
      client,
      '/api/openchamber/sessions/source/fork-capability',
      { directory: '/repo' },
    );

    assert.equal(response?.status, 200);
    assert.deepEqual(decode(response?.bodyText || '{}'), { supported: true });
    assert.deepEqual(updates, [{ openchamber: { agent_backend: 'omp' } }]);
  });

  test('forks a proven OMP source only to OMP and stamps the child from source authority', async () => {
    const source: Session = { id: 'source', metadata: { openchamber: { agent_backend: 'omp' } } };
    const fork: Session = { id: 'fork', directory: '/canonical/forks/fork', metadata: { keep: true, openchamber: {} } };
    const forkInputs: Array<{ sessionID: string; directory: string; messageID?: string }> = [];
    const updates: Array<{ sessionID: string; directory: string; metadata: Record<string, unknown> }> = [];
    const client = createClient({
      get: async (input) => ({ data: input.sessionID === 'source' ? source : fork }),
      update: async (input) => {
        updates.push({ sessionID: input.sessionID, directory: input.directory, metadata: input.metadata });
        fork.metadata = input.metadata;
        return { data: fork };
      },
      fork: async (input) => {
        forkInputs.push(input);
        return { data: fork };
      },
    });

    const response = await invoke(client, '/openchamber/sessions/source/fork-authorized', {
      directory: '/repo',
      messageId: 'message-a',
      providerID: 'omp',
    });

    assert.equal(response?.status, 200);
    assert.deepEqual(forkInputs, [{ sessionID: 'source', directory: '/repo', messageID: 'message-a' }]);
    assert.deepEqual(updates, [{
      sessionID: 'fork',
      directory: '/canonical/forks/fork',
      metadata: { keep: true, openchamber: { agent_backend: 'omp' } },
    }]);
    assert.deepEqual(decode(response?.bodyText || '{}'), {
      session: { id: 'fork', directory: '/canonical/forks/fork', metadata: { keep: true, openchamber: { agent_backend: 'omp' } } },
      directory: '/canonical/forks/fork',
    });
  });

  test('does not advertise or authorize Codex forks', async () => {
    const source: Session = { id: 'source', metadata: { openchamber: { agent_backend: 'codex' } } };
    let forkCount = 0;
    const client = createClient({
      get: async () => ({ data: source }),
      fork: async () => {
        forkCount += 1;
        return { data: { id: 'unexpected', directory: '/repo', metadata: {} } };
      },
    });

    const capability = await invoke(client, '/api/openchamber/sessions/source/fork-capability', {
      directory: '/repo',
    });
    assert.equal(capability?.status, 200);
    assert.deepEqual(decode(capability?.bodyText || '{}'), { supported: false });

    const response = await invoke(client, '/openchamber/sessions/source/fork-authorized', {
      directory: '/repo',
      providerID: 'codex',
    });
    assert.equal(response?.status, 409);
    assert.deepEqual(decode(response?.bodyText || '{}'), { error: 'Codex sessions cannot be forked' });
    assert.equal(forkCount, 0);
  });

  test('keeps a native child native for a nonmanaged target', async () => {
    const source: Session = { id: 'source', metadata: { openchamber: {} } };
    const fork: Session = { id: 'fork', directory: '/repo', metadata: { keep: true, openchamber: {} } };
    let updateCount = 0;
    const client = createClient({
      get: async () => ({ data: source }),
      update: async () => {
        updateCount += 1;
        return { data: fork };
      },
      messages: async () => ({
        data: [
          { info: { id: 'm-openai', providerID: 'openai' } },
          { info: { id: 'm-anthropic', providerID: 'anthropic' } },
        ],
      }),
      fork: async () => ({ data: fork }),
    });

    const response = await invoke(client, '/openchamber/sessions/source/fork-authorized', {
      directory: '/repo',
      providerID: 'openai',
    });

    assert.equal(response?.status, 200);
    assert.equal(updateCount, 0);
    assert.deepEqual(decode(response?.bodyText || '{}'), { session: fork, directory: '/repo' });
  });

  test('fails closed when an authorized fork omits its authoritative child directory', async () => {
    let deleteCount = 0;
    const client = createClient({
      fork: async () => ({ data: { id: 'fork-without-directory', metadata: {} } }),
      delete: async () => {
        deleteCount += 1;
        return { data: true };
      },
    });

    const response = await invoke(client, '/openchamber/sessions/source/fork-authorized', {
      directory: '/repo',
      providerID: 'openai',
    });

    assert.equal(response?.status, 502);
    assert.deepEqual(decode(response?.bodyText || '{}'), {
      error: 'Fork session did not return an authoritative session directory',
      partial: true,
      partialAction: 'fork-retained',
      sessionId: 'fork-without-directory',
      recovery: {
        fork: {
          confirmed: false,
          detail: 'forked session did not return an authoritative directory',
        },
      },
    });
    assert.equal(deleteCount, 0);
  });

  test('authorizes native sends without stamping managed metadata', async () => {
    let updateCount = 0;
    const client = createClient({
      messages: async () => ({
        data: [
          { info: { id: 'm-openai', providerID: 'openai' } },
          { info: { id: 'm-anthropic', providerID: 'anthropic' } },
        ],
      }),
      update: async () => {
        updateCount += 1;
        return { data: { id: 'source', metadata: {} } };
      },
    });

    const response = await invoke(client, '/openchamber/sessions/source/send-preflight', {
      directory: '/repo',
      providerID: 'openai',
    });

    assert.equal(response?.status, 200);
    assert.deepEqual(decode(response?.bodyText || '{}'), { authorized: true });
    assert.equal(updateCount, 0);
  });

  test('rejects native-to-managed sends during preflight', async () => {
    for (const providerID of ['pi', 'omp', 'codex']) {
      let updateCount = 0;
      const client = createClient({
        update: async () => {
          updateCount += 1;
          return { data: { id: 'source', metadata: {} } };
        },
      });

      const response = await invoke(client, '/openchamber/sessions/source/send-preflight', {
        directory: '/repo',
        providerID,
      });

      assert.equal(response?.status, 409);
      assert.deepEqual(decode(response?.bodyText || '{}'), {
        error: 'Native sessions cannot be converted to a managed agent backend by sending a prompt',
      });
      assert.equal(updateCount, 0);
    }
  });

  test('rejects managed backend changes during preflight', async () => {
    for (const [existing, requested] of [['pi', 'omp'], ['omp', 'pi'], ['omp', 'codex'], ['codex', 'omp']] as const) {
      let updateCount = 0;
      const client = createClient({
        get: async () => ({
          data: { id: 'source', metadata: { openchamber: { agent_backend: existing } } },
        }),
        update: async () => {
          updateCount += 1;
          return { data: { id: 'source', metadata: {} } };
        },
      });

      const response = await invoke(client, '/openchamber/sessions/source/send-preflight', {
        directory: '/repo',
        providerID: requested,
      });

      assert.equal(response?.status, 409);
      assert.deepEqual(decode(response?.bodyText || '{}'), {
        error: 'Managed agent session backend cannot be changed',
      });
      assert.equal(updateCount, 0);
    }
  });

  test('scans complete history and backfills a proven legacy OMP send', async () => {
    const source: Session = { id: 'source', metadata: {} };
    const updates: Array<{ directory: string; metadata: Record<string, unknown> }> = [];
    let historyReads = 0;
    const client = createClient({
      get: async () => ({ data: source }),
      update: async (input) => {
        updates.push({ directory: input.directory, metadata: input.metadata });
        source.metadata = input.metadata;
        return { data: source };
      },
      messages: async (input) => {
        historyReads += 1;
        return input.before
          ? { data: [{ info: { id: 'm-omp', providerID: 'omp' } }] }
          : {
              data: [{ info: { id: 'm-omp-recent', providerID: 'omp' } }],
              response: { headers: new Headers({ 'x-next-cursor': 'older' }) },
            };
      },
    });

    const response = await invoke(client, '/openchamber/sessions/source/send-preflight', {
      directory: '/repo',
      providerID: 'omp',
    });

    assert.equal(response?.status, 200);
    assert.equal(historyReads, 2);
    assert.deepEqual(updates, [{
      directory: '/repo',
      metadata: { openchamber: { agent_backend: 'omp' } },
    }]);
  });

  test('backfills a proven legacy OMP backend before rejecting an incompatible send', async () => {
    const source: Session = { id: 'source', metadata: {} };
    let updateCount = 0;
    const client = createClient({
      get: async () => ({ data: source }),
      messages: async () => ({ data: [{ info: { id: 'm-omp', providerID: 'omp' } }] }),
      update: async (input) => {
        updateCount += 1;
        source.metadata = input.metadata;
        return { data: source };
      },
    });

    const response = await invoke(client, '/openchamber/sessions/source/send-preflight', {
      directory: '/repo',
      providerID: 'openai',
    });

    assert.equal(response?.status, 409);
    assert.deepEqual(decode(response?.bodyText || '{}'), {
      error: 'Managed agent session backend cannot be changed',
    });
    assert.equal(updateCount, 1);
    assert.deepEqual(source.metadata, { openchamber: { agent_backend: 'omp' } });
  });

  test('rejects native and managed history before send preflight can backfill', async () => {
    let updateCount = 0;
    const client = createClient({
      messages: async (input) => input.before
        ? { data: [{ info: { id: 'm-omp', providerID: 'omp' } }] }
        : {
            data: [{ info: { id: 'm-native', providerID: 'openai' } }],
            response: { headers: new Headers({ 'x-next-cursor': 'older' }) },
          },
      update: async () => {
        updateCount += 1;
        return { data: { id: 'source', metadata: {} } };
      },
    });

    const response = await invoke(client, '/openchamber/sessions/source/send-preflight', {
      directory: '/repo',
      providerID: 'omp',
    });

    assert.equal(response?.status, 409);
    assert.deepEqual(decode(response?.bodyText || '{}'), {
      error: 'Mixed native/managed agent backend history cannot be used',
    });
    assert.equal(updateCount, 0);
  });

  test('fails send preflight closed when a later history page cannot be read', async () => {
    let updateCount = 0;
    const client = createClient({
      messages: async (input) => input.before
        ? { error: new Error('history unavailable'), response: { status: 503 } }
        : {
            data: [{ info: { id: 'm-native', providerID: 'openai' } }],
            response: { headers: new Headers({ 'x-next-cursor': 'older' }) },
          },
      update: async () => {
        updateCount += 1;
        return { data: { id: 'source', metadata: {} } };
      },
    });

    const response = await invoke(client, '/openchamber/sessions/source/send-preflight', {
      directory: '/repo',
      providerID: 'openai',
    });

    assert.equal(response?.status, 503);
    assert.deepEqual(decode(response?.bodyText || '{}'), {
      error: 'Failed to read source session history',
    });
    assert.equal(updateCount, 0);
  });

  test('rejects Pi targets and cross-backend conversion before fork dispatch', async () => {
    const cases = [
      { sourceBackend: 'omp', providerID: 'openai', error: 'Session backend cannot be changed by forking' },
      { sourceBackend: null, providerID: 'omp', error: 'Session backend cannot be changed by forking' },
      {
        sourceBackend: null,
        providerID: 'pi',
        error: 'Pi sessions cannot be created by forking because startup dialogs require an interactive client',
      },
    ] as const;

    for (const item of cases) {
      let forkCount = 0;
      const client = createClient({
        get: async () => ({
          data: {
            id: 'source',
            metadata: item.sourceBackend ? { openchamber: { agent_backend: item.sourceBackend } } : {},
          },
        }),
        fork: async () => {
          forkCount += 1;
          return { data: { id: 'unexpected' } };
        },
      });

      const response = await invoke(client, '/openchamber/sessions/source/fork-authorized', {
        directory: '/repo',
        providerID: item.providerID,
      });

      assert.equal(response?.status, 409);
      assert.deepEqual(decode(response?.bodyText || '{}'), { error: item.error });
      assert.equal(forkCount, 0);
    }
  });

  test('rejects Pi and review sources before fork dispatch', async () => {
    const sources = [
      {
        metadata: { openchamber: { agent_backend: 'pi' } },
        error: 'Pi sessions cannot be forked',
        historyReads: 1,
      },
      {
        metadata: { openchamber: { kind: 'review', originalSessionID: 'original' } },
        error: 'Review sessions cannot be forked',
        historyReads: 0,
      },

    ];

    for (const source of sources) {
      let historyReads = 0;
      let forkCount = 0;
      const client = createClient({
        get: async () => ({ data: { id: 'source', metadata: source.metadata } }),
        messages: async () => {
          historyReads += 1;
          return { data: [] };
        },
        fork: async () => {
          forkCount += 1;
          return { data: { id: 'unexpected' } };
        },
      });

      const response = await invoke(client, '/openchamber/sessions/source/fork-authorized', {
        directory: '/repo',
      });

      assert.equal(response?.status, 409);
      assert.deepEqual(decode(response?.bodyText || '{}'), { error: source.error });
      assert.equal(historyReads, source.historyReads);
      assert.equal(forkCount, 0);
    }
  });

  test('rejects mixed Pi and OMP history before stamping or forking', async () => {
    let updateCount = 0;
    let forkCount = 0;
    const client = createClient({
      messages: async (input) => input.before
        ? { data: [{ info: { id: 'm-omp', providerID: 'omp' } }] }
        : {
            data: [{ info: { id: 'm-pi', providerID: 'pi' } }],
            response: { headers: new Headers({ 'x-next-cursor': 'older' }) },
          },
      update: async () => {
        updateCount += 1;
        return { data: { id: 'source' } };
      },
      fork: async () => {
        forkCount += 1;
        return { data: { id: 'unexpected' } };
      },
    });

    const response = await invoke(client, '/openchamber/sessions/source/fork-authorized', {
      directory: '/repo',
    });

    assert.equal(response?.status, 409);
    assert.deepEqual(decode(response?.bodyText || '{}'), {
      error: 'Mixed native/managed agent backend history cannot be used',
    });
    assert.equal(updateCount, 0);
    assert.equal(forkCount, 0);
  });

  test('stops paging as soon as the current history page mixes backend classes', async () => {
    let historyReads = 0;
    let forkCount = 0;
    const client = createClient({
      messages: async () => {
        historyReads += 1;
        return {
          data: [
            { info: { id: 'm-native', providerID: 'openai' } },
            { info: { id: 'm-omp', providerID: 'omp' } },
          ],
          response: { headers: new Headers({ 'x-next-cursor': 'must-not-be-read' }) },
        };
      },
      fork: async () => {
        forkCount += 1;
        return { data: { id: 'unexpected' } };
      },
    });

    const response = await invoke(client, '/openchamber/sessions/source/fork-authorized', {
      directory: '/repo',
    });

    assert.equal(response?.status, 409);
    assert.deepEqual(decode(response?.bodyText || '{}'), {
      error: 'Mixed native/managed agent backend history cannot be used',
    });
    assert.equal(historyReads, 1);
    assert.equal(forkCount, 0);
  });

  test('rejects native and managed history before an authorized fork can backfill or dispatch', async () => {
    let updateCount = 0;
    let forkCount = 0;
    const client = createClient({
      messages: async (input) => input.before
        ? { data: [{ info: { id: 'm-omp', providerID: 'omp' } }] }
        : {
            data: [{ info: { id: 'm-native', providerID: 'openai' } }],
            response: { headers: new Headers({ 'x-next-cursor': 'older' }) },
          },
      update: async () => {
        updateCount += 1;
        return { data: { id: 'source' } };
      },
      fork: async () => {
        forkCount += 1;
        return { data: { id: 'unexpected' } };
      },
    });

    const response = await invoke(client, '/openchamber/sessions/source/fork-authorized', {
      directory: '/repo',
    });

    assert.equal(response?.status, 409);
    assert.deepEqual(decode(response?.bodyText || '{}'), {
      error: 'Mixed native/managed agent backend history cannot be used',
    });
    assert.equal(updateCount, 0);
    assert.equal(forkCount, 0);
  });

  test('fails closed when a later history page cannot be read', async () => {
    let forkCount = 0;
    const client = createClient({
      messages: async (input) => input.before
        ? { error: new Error('history unavailable'), response: { status: 503 } }
        : {
            data: [{ info: { id: 'm-native', providerID: 'openai' } }],
            response: { headers: new Headers({ 'x-next-cursor': 'older' }) },
          },
      fork: async () => {
        forkCount += 1;
        return { data: { id: 'unexpected' } };
      },
    });

    const response = await invoke(client, '/openchamber/sessions/source/fork-authorized', {
      directory: '/repo',
    });

    assert.equal(response?.status, 503);
    assert.deepEqual(decode(response?.bodyText || '{}'), { error: 'Failed to read source session history' });
    assert.equal(forkCount, 0);
  });

  test('fails closed when history pagination makes no progress', async () => {
    let calls = 0;
    const client = createClient({
      messages: async () => {
        calls += 1;
        return {
          data: [],
          response: { headers: new Headers({ 'x-next-cursor': 'same-cursor' }) },
        };
      },
    });

    const response = await invoke(client, '/openchamber/sessions/source/fork-authorized', {
      directory: '/repo',
    });

    assert.equal(response?.status, 502);
    assert.deepEqual(decode(response?.bodyText || '{}'), {
      error: 'Source session history pagination made no progress',
    });
    assert.equal(calls, 2);
  });

  test('compensates the exact child when the caller aborts after fork dispatch', async () => {
    const controller = new AbortController();
    const child: Session = { id: 'fork-after-abort', directory: '/canonical/forks/fork-after-abort', metadata: {} };
    let releaseFork: (() => void) | undefined;
    let markForkStarted: (() => void) | undefined;
    const forkStarted = new Promise<void>((resolve) => { markForkStarted = resolve; });
    const deleteInputs: Array<{ sessionID: string; directory: string }> = [];
    let deleted = false;
    const client = createClient({
      get: async (input) => {
        if (input.sessionID === child.id) {
          return deleted ? { response: { status: 404 } } : { data: child };
        }
        return { data: { id: 'source', metadata: {} } };
      },
      fork: async (_input, options) => {
        assert.equal(options, undefined);
        markForkStarted?.();
        await new Promise<void>((resolve) => { releaseFork = resolve; });
        return { data: child };
      },
      delete: async (input) => {
        deleteInputs.push(input);
        deleted = true;
        return { data: true };
      },
    });

    const pending = invoke(
      client,
      '/openchamber/sessions/source/fork-authorized',
      { directory: '/repo' },
      controller.signal,
    );
    await forkStarted;
    controller.abort();
    releaseFork?.();
    const response = await pending;

    assert.equal(response?.status, 499);
    assert.deepEqual(decode(response?.bodyText || '{}'), { error: 'Request cancelled' });
    assert.deepEqual(deleteInputs, [{ sessionID: child.id, directory: '/canonical/forks/fork-after-abort' }]);
  });

  test('returns typed retained recovery when post-dispatch compensation is unconfirmed', async () => {
    const controller = new AbortController();
    const child: Session = { id: 'fork-retained', directory: '/canonical/forks/fork-retained', metadata: {} };
    let releaseFork: (() => void) | undefined;
    let markForkStarted: (() => void) | undefined;
    const forkStarted = new Promise<void>((resolve) => { markForkStarted = resolve; });
    const client = createClient({
      get: async (input) => ({ data: input.sessionID === child.id ? child : { id: 'source', metadata: {} } }),
      fork: async () => {
        markForkStarted?.();
        await new Promise<void>((resolve) => { releaseFork = resolve; });
        return { data: child };
      },
      delete: async () => ({ data: false }),
    });

    const pending = invoke(
      client,
      '/openchamber/sessions/source/fork-authorized',
      { directory: '/repo' },
      controller.signal,
    );
    await forkStarted;
    controller.abort();
    releaseFork?.();
    const response = await pending;

    assert.equal(response?.status, 499);
    assert.deepEqual(decode(response?.bodyText || '{}'), {
      error: 'Request cancelled',
      partial: true,
      partialAction: 'fork-retained',
      sessionId: child.id,
      directory: '/canonical/forks/fork-retained',
      recovery: {
        fork: {
          confirmed: false,
          detail: 'OpenCode did not confirm deletion of the forked session',
        },
      },
    });
  });
});
