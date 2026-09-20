import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { switchRuntimeEndpoint } from '../runtime-switch';
import { createDisplayNameChoice } from '../messages/displayName';

type ConfigResponse = { data: Record<string, unknown> };

(mock as unknown as { restore?: () => void }).restore?.();

const configResolvers: Array<(response: ConfigResponse) => void> = [];
const healthResolvers: Array<(response: { data: { capabilities?: { displayAttribution: number } } }) => void> = [];
let configCalls = 0;
let runtimeKey = 'test-runtime';
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => Response.json({ token: 'fixture-url-token', expiresAt: Date.now() + 60_000 });
afterAll(() => { globalThis.fetch = originalFetch; });
const selectRuntime = (key: string) => {
  runtimeKey = key;
  switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime.example', runtimeKey: key });
};
const promptAsyncCalls: unknown[][] = [];
const promptAsyncResults: Array<unknown> = [];
const pathGetResults: Array<unknown> = [];
let messageView: string | undefined;
let messagePageCalls = 0;

const promptAsyncMock = mock(async (...args: unknown[]) => {
  promptAsyncCalls.push(args);
  const next = promptAsyncResults.shift();
  if (next instanceof Error) throw next;
  return next ?? { response: new Response(null, { status: 200 }) };
});

let pathGetCalls = 0;
let sessionListCalls = 0;
let projectWorktree: string | undefined;
const pathGetMock = mock(async () => {
  pathGetCalls += 1;
  const next = pathGetResults.shift();
  if (next instanceof Error) throw next;
  return next ?? { data: { directory: '/workspace/project' } };
});

mock.module('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: mock(() => ({
    global: { health: () => new Promise((resolve) => { healthResolvers.push(resolve); }) },
    config: {
      get: mock(() => {
        configCalls += 1;
        return new Promise<ConfigResponse>((resolve) => {
          configResolvers.push(resolve);
        });
      }),
    },
    project: { current: async () => ({ data: { worktree: projectWorktree } }) },
    session: {
      list: async () => { sessionListCalls += 1; return { data: [] }; },
      promptAsync: promptAsyncMock,
      messages: async () => {
        messagePageCalls += 1;
        return { data: [], response: new Response(null, {
          headers: messageView ? { 'x-smarty-ordinary-view': messageView } : {},
        }) };
      },
    },
    path: {
      get: pathGetMock,
    },
  })),
}));

mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: mock(() => null),
}));

type DirectoryProbeQuery = { path?: string };
const runtimeFetchCalls: Array<{ path: string; query: DirectoryProbeQuery | undefined }> = [];
const runtimeFetchResults: Array<Response | Error> = [];
const fsHomeResponses: Array<Response | Error> = [];

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async (input: string | URL | Request, init?: { query?: DirectoryProbeQuery }) => {
    if (typeof input === 'string' && input.includes('/fs/home')) {
      const next = fsHomeResponses.shift();
      if (next instanceof Error) throw next;
      if (next) return next;
    }
    if (typeof input === 'string') runtimeFetchCalls.push({ path: input, query: init?.query });
    const next = runtimeFetchResults.shift();
    if (next instanceof Error) throw next;
    return next ?? new Response(JSON.stringify([]), {
      headers: { 'Content-Type': 'application/json' },
    });
  }),
}));

mock.module('@/lib/startupTrace', () => ({
  markStartupTrace: mock(() => undefined),
}));

const { opencodeClient } = await import(`./client?cache-test=${Date.now()}`);
const { SessionMessageLoader, setImperativeSessionMessageLoader } = await import('@/sync/session-message-loader');
const { ChildStoreManager } = await import('@/sync/child-store');

beforeEach(() => {
  selectRuntime('test-runtime');
  messageView = undefined;
  messagePageCalls = 0;
  setImperativeSessionMessageLoader(null);
  promptAsyncCalls.length = 0;
  promptAsyncResults.length = 0;
  healthResolvers.length = 0;
  pathGetResults.length = 0;
  pathGetCalls = 0;
  sessionListCalls = 0;
  projectWorktree = undefined;
  opencodeClient.setDirectory(undefined);
  runtimeFetchCalls.length = 0;
  runtimeFetchResults.length = 0;
  fsHomeResponses.length = 0;
});

describe('ordinary accepted browser view forwarding', () => {
  const view = `ov2_${'a'.repeat(64)}`;
  const nextView = `ov2_${'b'.repeat(64)}`;
  const target = { directory: '/repo', sessionID: 'ordinary-a' };
  const params = { id: target.sessionID, directory: target.directory, runtimeKey: 'test-runtime',
    providerID: 'ordinary-fixture', modelID: 'test', text: 'hello' };

  const fixture = async () => {
    const childStores = new ChildStoreManager();
    const loader = new SessionMessageLoader(childStores, { sdk: opencodeClient.getSdkClient(), runtimeKey });
    setImperativeSessionMessageLoader(loader);
    messageView = view;
    await loader.ensure(target);
    return { loader, close() { setImperativeSessionMessageLoader(null); loader.dispose(); childStores.disposeAll(); } };
  };

  test('forwards the materialized session view through SDK options and revokes it after submission', async () => {
    const f = await fixture();
    try {
      await opencodeClient.sendMessage(params);
      expect(promptAsyncCalls).toHaveLength(1);
      expect(promptAsyncCalls[0][1]).toEqual({ headers: { 'x-smarty-ordinary-view': view } });
      expect(f.loader.getAcceptedOrdinaryView(target, runtimeKey)).toBe(undefined);
    } finally { f.close(); }
  });

  test('does not borrow another session view and never retries a rejected mutation', async () => {
    const f = await fixture();
    try {
      promptAsyncResults.push({ response: new Response('missing view', { status: 409 }) });
      await expect(opencodeClient.sendMessage({ ...params, id: 'ordinary-b' })).rejects.toThrow('(409)');
      expect(promptAsyncCalls).toHaveLength(1);
      expect(promptAsyncCalls[0][1]).toBe(undefined);
      expect(f.loader.getAcceptedOrdinaryView(target, runtimeKey)).toBe(view);
    } finally { f.close(); }
  });

  test('rejects view invalidation during asynchronous preparation before dispatch', async () => {
    const f = await fixture();
    try {
      const sending = opencodeClient.sendMessage({ ...params, displayName: 'Paul' });
      f.loader.invalidateOrdinaryViews();
      healthResolvers.shift()?.({ data: { capabilities: { displayAttribution: 1 } } });
      await expect(sending).rejects.toThrow('view changed before submission');
      expect(promptAsyncCalls).toHaveLength(0);
    } finally { f.close(); }
  });

  test('refreshes a rejected stale view by GET without replaying the prompt', async () => {
    const f = await fixture();
    try {
      messageView = nextView;
      promptAsyncResults.push({ response: new Response('stale view', { status: 409 }) });
      const refreshed = new Promise<void>((resolve) => {
        const unsubscribe = f.loader.subscribe(target, () => {
          if (f.loader.getAcceptedOrdinaryView(target, runtimeKey) !== nextView) return;
          unsubscribe();
          resolve();
        });
      });
      await expect(opencodeClient.sendMessage(params)).rejects.toThrow('(409)');
      await refreshed;
      expect(promptAsyncCalls).toHaveLength(1);
      expect(messagePageCalls).toBe(2);
      expect(f.loader.getAcceptedOrdinaryView(target, runtimeKey)).toBe(nextView);
    } finally { f.close(); }
  });
});

describe('home discovery does not probe project sessions', () => {
  for (const directory of [undefined, '/', '/workspace/owned']) {
    test(`unavailable metadata preserves fallback without listing sessions (${directory ?? 'unset'})`, async () => {
      opencodeClient.setDirectory(directory);
      pathGetResults.push(new Error('metadata unavailable'));
      await opencodeClient.getSystemInfo();
      expect(pathGetCalls).toBe(1);
      expect(sessionListCalls).toBe(0);
      expect(opencodeClient.getDirectory()).toBe(directory);
    });
  }

  test('resolved project metadata remains a supported home-discovery source', async () => {
    opencodeClient.setDirectory('/workspace/owned');
    pathGetResults.push(new Error('path metadata unavailable'));
    projectWorktree = '/workspace/owned';
    const info = await opencodeClient.getSystemInfo();
    expect(info.homeDirectory).toBe('/workspace/owned');
    expect(sessionListCalls).toBe(0);
    expect(opencodeClient.getDirectory()).toBe('/workspace/owned');
  });

  test('explicitly selected root metadata is not rejected or replaced', async () => {
    opencodeClient.setDirectory('/');
    pathGetResults.push({ data: { directory: '/', worktree: '/' } });
    const info = await opencodeClient.getSystemInfo();
    expect(info.homeDirectory).toBe('/');
    expect(opencodeClient.getDirectory()).toBe('/');
    expect(sessionListCalls).toBe(0);
  });

  for (const directory of ['/', '/workspace/owned']) {
    test(`explicit session discovery remains available (${directory})`, async () => {
      opencodeClient.setDirectory(directory);
      expect(await opencodeClient.listSessions()).toEqual([]);
      expect(sessionListCalls).toBe(1);
      expect(opencodeClient.getDirectory()).toBe(directory);
    });
  }

  test('the supported filesystem-home API does not discover project sessions', async () => {
    fsHomeResponses.push(Response.json({ home: '/home/fixture' }));
    expect(await opencodeClient.getFilesystemHome()).toBe('/home/fixture');
    expect(pathGetCalls).toBe(0);
    expect(sessionListCalls).toBe(0);
  });
});

describe('opencodeClient directory availability', () => {
  type ProbeBody = { error?: string; reason?: string; entries?: never[] };
  const json = (status: number, body: ProbeBody): Response => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

  test('stats the directory through the OpenChamber filesystem route, never through OpenCode path resolution', async () => {
    runtimeFetchResults.push(json(200, { entries: [] }));
    expect(await opencodeClient.getDirectoryAvailability('/private/deleted-worktree')).toBe('available');
    expect(runtimeFetchCalls).toEqual([{ path: '/api/fs/list', query: { path: '/private/deleted-worktree' } }]);
    expect(pathGetCalls).toBe(0);
  });

  test('distinguishes a missing directory from an unavailable probe', async () => {
    runtimeFetchResults.push(json(404, { error: 'Directory not found', reason: 'not-found' }));
    expect(await opencodeClient.getDirectoryAvailability('/private/deleted-worktree')).toBe('missing');

    runtimeFetchResults.push(json(400, { error: 'Specified path is not a directory', reason: 'not-directory' }));
    expect(await opencodeClient.getDirectoryAvailability('/private/deleted-worktree')).toBe('missing');

    runtimeFetchResults.push(json(404, { error: 'Not Found' }));
    expect(await opencodeClient.getDirectoryAvailability('/private/deleted-worktree')).toBe('unknown');

    runtimeFetchResults.push(json(500, { error: 'Failed to list directory' }));
    expect(await opencodeClient.getDirectoryAvailability('/private/deleted-worktree')).toBe('unknown');

    runtimeFetchResults.push(new Error('offline'));
    expect(await opencodeClient.getDirectoryAvailability('/private/deleted-worktree')).toBe('unknown');
  });
});

describe('opencodeClient getFilesystemHomeInfo', () => {
  type HomePayload = { home?: string; chatsRoot?: string | number };
  const fsHomeResponse = (body: HomePayload) => new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });

  test('returns the server-provided chats root', async () => {
    fsHomeResponses.push(fsHomeResponse({ home: '/Users/tester', chatsRoot: '/srv/openchamber-chats' }));
    expect(await opencodeClient.getFilesystemHomeInfo()).toEqual({ home: '/Users/tester', chatsRoot: '/srv/openchamber-chats' });
  });

  test('returns the home for an older server that answers without chatsRoot', async () => {
    fsHomeResponses.push(fsHomeResponse({ home: '/Users/tester' }));
    expect(await opencodeClient.getFilesystemHomeInfo()).toEqual({ home: '/Users/tester' });
  });

  test('throws on a failed fetch', async () => {
    fsHomeResponses.push(new Error('transient network failure'));
    await expect(opencodeClient.getFilesystemHomeInfo()).rejects.toThrow('transient network failure');
  });

  test('throws on a non-ok response', async () => {
    fsHomeResponses.push(new Response('unavailable', { status: 503 }));
    await expect(opencodeClient.getFilesystemHomeInfo()).rejects.toThrow('503');
  });

  test('rejects missing home and relative roots rather than caching a fallback', async () => {
    fsHomeResponses.push(fsHomeResponse({}));
    await expect(opencodeClient.getFilesystemHomeInfo()).rejects.toThrow();
    fsHomeResponses.push(fsHomeResponse({ home: '/home/user', chatsRoot: 'relative' }));
    await expect(opencodeClient.getFilesystemHomeInfo()).rejects.toThrow();
  });

  test('throws on a malformed payload', async () => {
    fsHomeResponses.push(fsHomeResponse({ chatsRoot: 42 }));
    await expect(opencodeClient.getFilesystemHomeInfo()).rejects.toThrow();
  });
});

describe('opencodeClient getConfig cache', () => {
  test('cleared stale in-flight requests do not repopulate cache or delete newer in-flight requests', async () => {
    const first = opencodeClient.getConfig('/workspace/project');
    expect(configCalls).toBe(1);

    opencodeClient.clearConfigCache();

    const second = opencodeClient.getConfig('/workspace/project');
    expect(configCalls).toBe(2);

    configResolvers[0]?.({ data: { model: 'old/model' } });
    expect(await first).toEqual({ model: 'old/model' });

    const third = opencodeClient.getConfig('/workspace/project');
    expect(configCalls).toBe(2);

    configResolvers[1]?.({ data: { model: 'new/model' } });
    expect(await second).toEqual({ model: 'new/model' });
    expect(await third).toEqual({ model: 'new/model' });

    const cached = await opencodeClient.getConfig('/workspace/project');
    expect(cached).toEqual({ model: 'new/model' });
    expect(configCalls).toBe(2);
  });
});

describe('opencodeClient prompt retry behavior', () => {
  const sendPrompt = (providerID = 'anthropic') => opencodeClient.sendMessage({
    id: 'ses_1',
    providerID,
    modelID: 'claude-sonnet',
    text: 'hello',
  });

  test('does not retry 504 prompt responses because the POST may already be accepted', async () => {
    promptAsyncResults.push({ response: new Response('gateway timeout', { status: 504 }) });

    let error: unknown = null;
    try {
      await sendPrompt('anthropic-504');
    } catch (caught) {
      error = caught;
    }

    expect(promptAsyncCalls.length).toBe(1);
    expect(error instanceof Error ? error.message : String(error)).toContain('Failed to send message (504)');
  });

  test('does not retry transport failures because the tunnel may have lost only the response', async () => {
    promptAsyncResults.push(new TypeError('Failed to fetch'));

    let error: unknown = null;
    try {
      await sendPrompt('anthropic-network');
    } catch (caught) {
      error = caught;
    }

    expect(promptAsyncCalls.length).toBe(1);
    expect(error instanceof Error ? error.message : String(error)).toContain('Failed to fetch');
  });

  test('does not fabricate an HTTP 500 when the SDK swallows a transport failure into result.error', async () => {
    // The SDK catches thrown fetch errors and returns { error, response: undefined }.
    // That is a transport failure, not a server 500 — it must surface as a
    // descriptive transport error, never as "Failed to send message (500): {}".
    promptAsyncResults.push({ error: new TypeError('relay tunnel reset: plaintext frame on established channel'), response: undefined });

    let error: unknown = null;
    try {
      await sendPrompt('anthropic-transport');
    } catch (caught) {
      error = caught;
    }

    expect(promptAsyncCalls.length).toBe(1);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).not.toContain('Failed to send message (500)');
    expect(message).toContain('transport failure');
    expect(message).toContain('relay tunnel reset');
    expect((error as Error & { status?: number }).status).toBe(undefined);
  });

  test('does not retry 503 prompt responses because proxy errors can be ambiguous too', async () => {
    promptAsyncResults.push({ response: new Response('starting', { status: 503 }) });

    let error: unknown = null;
    try {
      await sendPrompt('anthropic-503');
    } catch (caught) {
      error = caught;
    }

    expect(promptAsyncCalls.length).toBe(1);
    expect(error instanceof Error ? error.message : String(error)).toContain('Failed to send message (503)');
  });

  test('does not dispatch after the runtime changes while preparing attachments', async () => {
    selectRuntime('runtime-a');
    const pending = opencodeClient.sendMessage({
      id: 'ses_runtime_race',
      providerID: 'runtime-race-provider',
      modelID: 'model-a',
      text: 'hello',
      runtimeKey: 'runtime-a',
      files: [{
        type: 'file',
        mime: 'text/markdown',
        filename: 'notes.md',
        url: 'data:text/markdown,hello',
      }],
    });

    selectRuntime('runtime-b');

    let error: unknown = null;
    try {
      await pending;
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : String(error)).toContain('runtime changed');
    expect(promptAsyncCalls).toHaveLength(0);
  });
});

describe('display attribution transport', () => {
  const request = (displayName?: string) => ({ id: 'shared-session', providerID: 'attribution-fixture',
    modelID: 'fixture', text: '  same prompt\r\nunchanged  ', displayName, runtimeKey: 'test-runtime' });
  const capable = { data: { capabilities: { displayAttribution: 1 } } };

  test('snapshots distinct concurrent names before capability requests settle', async () => {
    const params = request('Paul');
    const paul = opencodeClient.sendMessage(params);
    params.displayName = 'Changed after submission';
    const kate = opencodeClient.sendMessage(request('Kate'));
    expect(healthResolvers).toHaveLength(2);
    healthResolvers[1](capable);
    await kate;
    healthResolvers[0](capable);
    await paul;
    expect(promptAsyncCalls.map(call => call[0])).toMatchObject([
      { parts: [{ type: 'text', text: request().text, metadata: { smartyCodeDisplayName: 'Kate' } }] },
      { parts: [{ type: 'text', text: request().text, metadata: { smartyCodeDisplayName: 'Paul' } }] },
    ]);
  });

  test('unnamed clients keep their original payload and need no capability lookup', async () => {
    await opencodeClient.sendMessage(request());
    expect(healthResolvers).toHaveLength(0);
    expect(promptAsyncCalls[0][0]).toMatchObject({ parts: [{ type: 'text', text: request().text }] });
    expect(JSON.stringify(promptAsyncCalls[0])).not.toContain('smartyCodeDisplayName');
  });

  test('explicit storage-denial recovery sends the original unnamed payload', async () => {
    const denied = () => { throw new Error('Storage denied'); };
    const choice = createDisplayNameChoice(denied);
    expect(() => choice.read()).toThrow('Storage denied');
    expect(promptAsyncCalls).toHaveLength(0);
    choice.useUnnamedForTab();
    await opencodeClient.sendMessage(request(choice.read()));
    expect(healthResolvers).toHaveLength(0);
    expect(promptAsyncCalls[0][0]).toMatchObject({ parts: [{ type: 'text', text: request().text }] });
    expect(JSON.stringify(promptAsyncCalls[0])).not.toContain('smartyCodeDisplayName');
  });

  test('unsupported backends and invalid names fail before prompt dispatch', async () => {
    const pending = opencodeClient.sendMessage(request('Kate'));
    healthResolvers[0]({ data: {} });
    await expect(pending).rejects.toThrow('does not support display attribution');
    for (const name of ['Paul\nKate', 'x'.repeat(65)]) {
      await expect(opencodeClient.sendMessage(request(name))).rejects.toThrow();
    }
    expect(promptAsyncCalls).toHaveLength(0);
  });

  test('a runtime switch during capability lookup cannot send to the new backend', async () => {
    const pending = opencodeClient.sendMessage(request('Paul'));
    selectRuntime('different-runtime');
    healthResolvers[0](capable);
    await expect(pending).rejects.toThrow('runtime changed');
    expect(promptAsyncCalls).toHaveLength(0);
  });
});
