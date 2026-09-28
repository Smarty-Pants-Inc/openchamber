import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNotificationTemplateRuntime } from './template-runtime.js';

const originalFetch = globalThis.fetch;

const createRuntime = (settings = {}) => createNotificationTemplateRuntime({
  readSettingsFromDisk: async () => settings,
  persistSettings: vi.fn(async () => {}),
  buildOpenCodeUrl: (path) => path,
  getOpenCodeAuthHeaders: () => ({}),
  resolveGitBinaryForSpawn: () => 'git',
});

describe('notification template runtime zen models', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns no selectable zen models after provider retirement', async () => {
    const runtime = createRuntime();
    const models = await runtime.fetchFreeZenModels();

    expect(models).toEqual([]);
  });

  it('preserves stored zen model value for compatibility without validation', async () => {
    const runtime = createRuntime({ zenModel: 'trinity-large-preview-free' });

    await expect(runtime.resolveZenModel()).resolves.toBe('trinity-large-preview-free');
  });
});

describe('notification template message extraction', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('excludes reasoning parts from payload message text', () => {
    const runtime = createRuntime();

    expect(runtime.extractLastMessageText({
      properties: {
        info: {
          parts: [
            { type: 'reasoning', text: 'private chain of thought' },
            { type: 'text', text: 'final answer' },
          ],
        },
      },
    })).toBe('final answer');
  });

  it('ignores untyped parts even when they contain text', () => {
    const runtime = createRuntime();

    expect(runtime.extractLastMessageText({
      properties: {
        info: {
          parts: [
            { text: 'untyped text' },
            { content: 'untyped content' },
            { type: 'text', text: 'typed final answer' },
          ],
        },
      },
    })).toBe('typed final answer');
  });

  it('excludes reasoning parts when fetching assistant messages', async () => {
    const runtime = createRuntime();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([
      {
        info: { id: 'msg-1', role: 'assistant', finish: 'stop' },
        parts: [
          { type: 'reasoning', text: 'private chain of thought' },
          { type: 'text', text: 'final answer' },
        ],
      },
    ])));

    await expect(runtime.fetchLastAssistantMessageText('session-1', 'msg-1')).resolves.toBe('final answer');
  });
});

describe('notification template session lookup', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // smarty-code#536: the title lookup reached the backend without its credentials and was refused (401) on every
  // session.idle of a session whose event had no title; every other backend call here sends them.
  it('sends the backend credentials when it looks up a session title', async () => {
    const runtime = createNotificationTemplateRuntime({
      readSettingsFromDisk: async () => ({}),
      persistSettings: vi.fn(async () => {}),
      buildOpenCodeUrl: (path) => path,
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer backend-token' }),
      resolveGitBinaryForSpawn: () => 'git',
    });
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url: String(url), headers: init?.headers });
      return new Response(JSON.stringify({ id: 'session-7', title: 'Fleet session' }), { status: 200 });
    });

    const variables = await runtime.buildTemplateVariables({ type: 'session.idle', properties: { sessionID: 'session-7' } }, 'session-7');

    const lookup = calls.find(call => call.url.startsWith('/session/session-7'));
    expect(lookup?.headers).toMatchObject({ Authorization: 'Bearer backend-token' });
    expect(variables.session_name).toBe('Fleet session');
  });
});

describe('notification lookups name the session directory', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // smarty-code#712: a lookup without a directory made the gateway list every project (40 on the fleet) to find the
  // session's owner, on each fleet session.idle. The event's directory goes with each lookup.
  it('sends the directory with the title and last-message lookups', async () => {
    const runtime = createRuntime();
    const urls = [];
    globalThis.fetch = vi.fn(async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify(String(url).includes('/message') ? [] : { id: 's7', title: 'T' }), { status: 200 });
    });
    await runtime.buildTemplateVariables({ type: 'session.idle', properties: { sessionID: 's7' } }, 's7', '/home/p/project');
    await runtime.fetchLastAssistantMessageText('s7', 'm1', undefined, '/home/p/project');
    expect(urls).toEqual(['/session/s7?directory=%2Fhome%2Fp%2Fproject', '/session/s7/message?limit=5&directory=%2Fhome%2Fp%2Fproject']);
    urls.length = 0;
    await runtime.fetchLastAssistantMessageText('s8', 'm1'); // No directory known: as before.
    expect(urls).toEqual(['/session/s8/message?limit=5']);
  });
});
