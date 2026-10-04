import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ZEN_ANONYMOUS_API_KEY,
  configureOpenCodeRuntimeProviders,
  getRuntimeProvider,
  getRuntimeProviderSnapshot,
  resetOpenCodeRuntimeProviders,
} from './runtime-providers.js';

const providerPayload = (overrides = {}) => ({
  all: [
    {
      id: 'llmapi',
      source: 'config',
      options: { apiKey: 'plugin-key', baseURL: 'https://api.llmapi.ai/v1/' },
      models: {
        'claude-opus-4-8': { api: { id: 'claude-opus-4-8', url: '', npm: '@ai-sdk/anthropic' } },
        'gpt-5.6-luna': { api: { id: 'gpt-5.6-luna', url: 'https://api.llmapi.ai/v1', npm: '@ai-sdk/openai' } },
      },
    },
    {
      id: 'opencode',
      source: 'custom',
      options: { apiKey: ZEN_ANONYMOUS_API_KEY },
      models: { 'free-model': { api: { id: 'free-model', url: 'https://opencode.ai/zen/v1', npm: '@ai-sdk/openai-compatible' } } },
    },
    {
      id: 'zai-coding-plan',
      source: 'api',
      key: 'auth-json-key',
      options: {},
      models: { 'glm-5': { api: { id: 'glm-5', url: 'https://api.z.ai/api/coding/paas/v4', npm: '@ai-sdk/openai-compatible' } } },
    },
  ],
  connected: ['llmapi', 'opencode', 'zai-coding-plan'],
  ...overrides,
});

describe('OpenCode runtime provider snapshot', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify(providerPayload()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    configureOpenCodeRuntimeProviders({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic test' }),
    });
  });

  afterEach(() => {
    configureOpenCodeRuntimeProviders(null);
    resetOpenCodeRuntimeProviders();
    vi.unstubAllGlobals();
  });

  it('reports the credential and endpoint a plugin registered at runtime', async () => {
    const provider = await getRuntimeProvider('llmapi');

    expect(provider).toMatchObject({
      apiKey: 'plugin-key',
      baseURL: 'https://api.llmapi.ai/v1',
      explicitBaseURL: 'https://api.llmapi.ai/v1',
    });
    expect(provider.models.get('gpt-5.6-luna')).toEqual({
      api: { url: 'https://api.llmapi.ai/v1', npm: '@ai-sdk/openai' },
    });
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:4096/provider');
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ Authorization: 'Basic test' });
  });

  it('refuses the zen sentinel as a credential', async () => {
    const provider = await getRuntimeProvider('opencode');

    expect(provider.apiKey).toBeNull();
    expect(provider.anonymousZen).toBe(true);
    // The endpoint is still reported; only the credential is withheld.
    expect(provider.baseURL).toBe('https://opencode.ai/zen/v1');
  });

  it('falls back to the model endpoint when the provider carries no baseURL', async () => {
    expect(await getRuntimeProvider('zai-coding-plan')).toMatchObject({
      baseURL: 'https://api.z.ai/api/coding/paas/v4',
      explicitBaseURL: null,
    });
  });

  it('serves one snapshot to concurrent callers instead of refetching', async () => {
    await Promise.all([getRuntimeProvider('llmapi'), getRuntimeProvider('opencode'), getRuntimeProvider('zai-coding-plan')]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('answers "unknown" rather than "no providers" when OpenCode is unreachable', async () => {
    resetOpenCodeRuntimeProviders();
    fetchMock.mockRejectedValue(new Error('connection refused'));

    expect(await getRuntimeProviderSnapshot()).toBeNull();
  });

  it('keeps the previous snapshot when a later refresh fails', async () => {
    await getRuntimeProviderSnapshot();
    fetchMock.mockRejectedValue(new Error('connection refused'));

    // Past the snapshot TTL, so the next read genuinely attempts a refresh.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60_000);
    const refreshed = await getRuntimeProviderSnapshot();
    vi.useRealTimers();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshed.providers.has('llmapi')).toBe(true);
  });

  it('stays on file-based resolution until it is configured', async () => {
    configureOpenCodeRuntimeProviders(null);

    expect(await getRuntimeProvider('llmapi')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Exercise the real receiver, generation service, file readers and runtime
// parser together. Only the remote HTTP responses are fixtures; no production
// module is mocked, and HOME is isolated before importing the file readers.
describe('small-model receiver endpoint provenance', () => {
  const destinations = {
    runtime: 'http://127.0.0.1:46101/v1',
    selected: 'http://127.0.0.2:46102/v1',
    first: 'http://127.0.0.3:46103/v1',
    file: 'http://127.0.0.4:46104/v1',
  };
  const listingURL = 'http://127.0.0.5:46105/provider';
  const credentials = ['fixture-runtime-key', 'fixture-file-key', 'fixture-auth-key', 'Basic fixture-engine-auth'];
  let fixtureDir;
  let request;
  let app;
  let fetchMock;
  let payload;
  let logSpy;

  beforeAll(async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'small-model-provenance-'));
    vi.stubEnv('HOME', fixtureDir);
    vi.stubEnv('XDG_CONFIG_HOME', path.join(fixtureDir, 'config'));
    vi.stubEnv('OPENCHAMBER_DATA_DIR', path.join(fixtureDir, 'openchamber'));
    vi.stubEnv('OPENCODE_CONFIG', undefined);
    const authDir = path.join(fixtureDir, '.local', 'share', 'opencode');
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, 'auth.json'), JSON.stringify({
      custom: { type: 'api', key: 'fixture-auth-key' },
    }));
    const { default: express } = await import('express');
    ({ default: request } = await import('supertest'));
    const { registerSmallModelRoutes } = await import('./routes.js');
    const service = await import('./index.js');
    app = express();
    app.use(express.json());
    registerSmallModelRoutes(app, { getSmallModelService: async () => service });
  });

  beforeEach(() => {
    fs.writeFileSync(path.join(fixtureDir, 'opencode.json'), '{}');
    payload = {
      all: [{
        id: 'custom',
        options: { apiKey: 'fixture-runtime-key', baseURL: destinations.runtime },
        models: {
          first: { api: { url: destinations.first, npm: '@ai-sdk/openai-compatible' } },
          selected: { api: { url: destinations.selected, npm: '@ai-sdk/openai-compatible' } },
        },
      }],
      connected: ['custom'],
    };
    fetchMock = vi.fn(async (url) => {
      if (url === listingURL) return Response.json(payload);
      if (url === 'https://models.dev/api.json') return Response.json({});
      if (Object.values(destinations).some((baseURL) => url === `${baseURL}/chat/completions`)) {
        return Response.json({ choices: [{ message: { content: 'fixture answer' }, finish_reason: 'stop' }] });
      }
      throw new Error('Unexpected outbound request');
    });
    vi.stubGlobal('fetch', fetchMock);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    configureOpenCodeRuntimeProviders({
      buildOpenCodeUrl: () => listingURL,
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic fixture-engine-auth' }),
    });
  });

  afterEach(() => {
    configureOpenCodeRuntimeProviders(null);
    vi.unstubAllGlobals();
    logSpy.mockRestore();
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it.each([
    ['explicit runtime gateway wins over selected metadata', destinations.runtime, 'fixture-runtime-key'],
    ['file configuration wins over runtime and selected metadata', destinations.file, 'fixture-file-key'],
    ['selected metadata replaces only the first-model fallback', destinations.selected, 'fixture-runtime-key'],
    ['blank runtime gateway permits selected metadata', destinations.selected, 'fixture-runtime-key'],
    ['missing selected endpoint uses the first-model fallback', destinations.first, 'fixture-runtime-key'],
    ['file configuration works without a runtime connection', destinations.file, 'fixture-file-key'],
  ])('%s', async (scenario, destination, key) => {
    if (scenario.startsWith('file configuration')) {
      fs.writeFileSync(path.join(fixtureDir, 'opencode.json'), JSON.stringify({
        provider: { custom: { options: { baseURL: destinations.file, apiKey: 'fixture-file-key' } } },
      }));
    }
    if (scenario === 'file configuration works without a runtime connection') configureOpenCodeRuntimeProviders(null);
    if (scenario === 'selected metadata replaces only the first-model fallback') delete payload.all[0].options.baseURL;
    if (scenario === 'blank runtime gateway permits selected metadata') payload.all[0].options.baseURL = '   ';
    if (scenario === 'missing selected endpoint uses the first-model fallback') {
      delete payload.all[0].options.baseURL;
      payload.all[0].models.selected.api.url = '';
    }

    const response = await request(app).post('/api/small-model/generate').send({
      model: 'custom/selected', directory: fixtureDir, prompt: 'fixture prompt', system: 'fixture system', maxOutputTokens: 32,
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ text: 'fixture answer', providerID: 'custom', modelID: 'selected', source: 'request' });
    const generations = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(generations).toHaveLength(1);
    const [url, init] = generations[0];
    expect(url).toBe(`${destination}/chat/completions`);
    expect(init.headers.Authorization).toBe(`Bearer ${key}`);
    expect(JSON.parse(init.body)).toMatchObject({
      model: 'selected', messages: [{ role: 'system', content: 'fixture system' }, { role: 'user', content: 'fixture prompt' }],
      max_tokens: 32, stream: false,
    });
    for (const credential of credentials) {
      expect(url).not.toContain(credential);
      expect(init.body).not.toContain(credential);
      expect(JSON.stringify(response.body)).not.toContain(credential);
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain(credential);
    }
    for (const [otherURL, otherInit] of fetchMock.mock.calls.filter(([, init]) => init?.method !== 'POST')) {
      expect(otherInit?.headers?.Authorization).toBe(otherURL === listingURL ? 'Basic fixture-engine-auth' : undefined);
    }
  });
});
