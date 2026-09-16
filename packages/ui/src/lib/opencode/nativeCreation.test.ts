import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { opencodeClient } from './client';
import { configureRuntimeUrlResolver } from '../runtime-url';
import { NativeCreationError, nativeCreatedSession, nativeCreationFailure, nativeCreationHealthSchema } from './nativeCreation';
import { nativeCreationI18n } from '../i18n/messages/native-creation.i18n';

const session = { id: '01234567-1234-4234-9234-012345678901', slug: 'native', projectID: 'p', directory: '/project',
  title: 'Pi', version: '1', time: { created: 1, updated: 1 },
  nativeCreation: { model: { providerID: 'actual-native-provider', modelID: 'actual-native-model' }, inputReady: false } };
const fetchMock = spyOn(globalThis, 'fetch');
configureRuntimeUrlResolver({ apiBaseUrl: 'http://synthetic.invalid' });
opencodeClient.reconnectToRuntimeBaseUrl();
afterEach(() => { fetchMock.mockReset(); });
afterAll(() => { fetchMock.mockRestore(); configureRuntimeUrlResolver({}); opencodeClient.reconnectToRuntimeBaseUrl(); });

describe('native create-only SDK boundary', () => {
  test('only the explicit versioned capability grants support', () => {
    expect(nativeCreationHealthSchema.parse({ healthy: true }).capabilities).toBeUndefined();
    expect(nativeCreationHealthSchema.parse({ healthy: true, capabilities: { displayAttribution: 1 } }).capabilities?.ordinaryCreateOnly).toBeUndefined();
    for (const value of [null, {}, { healthy: false }, { healthy: true, capabilities: { ordinaryCreateOnly: true } }]) {
      expect(nativeCreationHealthSchema.safeParse(value).success).toBe(false);
    }
  });
  test('SDK health and one empty-body create retain selected-project routing and native model', async () => {
    const requests: Request[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      const request = new Request(input, init); requests.push(request);
      if (request.method === 'GET') return Response.json({ healthy: true, capabilities: { ordinaryCreateOnly: 1 } });
      return Response.json(session);
    });
    expect(await opencodeClient.supportsNativeCreation('/project')).toBe(true);
    expect(await opencodeClient.createNativeSession('/project')).toEqual(session);
    expect(requests).toHaveLength(2);
    expect(new URL(requests[0].url).pathname).toBe('/api/global/health');
    // SDK1.18.29 rewrites scoped GET headers into directory and location[directory] query fields.
    expect(new URL(requests[0].url).searchParams.get('directory')).toBe('/project');
    expect(new URL(requests[0].url).searchParams.get('location[directory]')).toBe('/project');
    expect(new URL(requests[1].url).pathname).toBe('/api/session');
    expect(new URL(requests[1].url).searchParams.get('directory')).toBe('/project');
    expect(await requests[1].text()).toBe('');
    expect(requests[1].headers.get('content-type')).toBeNull();
  });
  test('capability absence is legacy, but a failed SDK health read is not absence', async () => {
    fetchMock.mockImplementation(async () => Response.json({ healthy: true }));
    expect(await opencodeClient.supportsNativeCreation('/project')).toBe(false);
    fetchMock.mockImplementation(async () => Response.json({ message: 'offline' }, { status: 503 }));
    await expect(opencodeClient.supportsNativeCreation('/project')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  test('safe unknown-outcome details survive without serializing credentials or retrying', async () => {
    const detail = 'Native creation outcome unknown; inspect w1:p2 and /private/native-abc/session.jsonl. Do not retry automatically.';
    fetchMock.mockImplementation(async () => Response.json({ name: 'APIError', data: {
      message: detail, isRetryable: false, credential: 'PRIVATE_SENTINEL',
    } }, { status: 503 }));
    try { await opencodeClient.createNativeSession('/project'); throw new Error('Expected refusal'); }
    catch (cause) {
      expect(cause).toBeInstanceOf(NativeCreationError);
      if (!(cause instanceof NativeCreationError)) throw cause;
      expect(cause.detail).toBe(detail);
      expect(JSON.stringify(cause)).not.toContain('PRIVATE_SENTINEL');
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const raw = new Error('token=PRIVATE_SENTINEL');
    expect(nativeCreationFailure(raw).cause).toBe(raw);
    expect(nativeCreationFailure(raw).detail).toBeUndefined();
  });
  test('missing native metadata is uncertain after POST, not a placeholder model or retry', async () => {
    fetchMock.mockImplementation(async () => Response.json({ ...session, nativeCreation: undefined }));
    await expect(opencodeClient.createNativeSession('/project')).rejects.toBeInstanceOf(NativeCreationError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const missing = { ...session, nativeCreation: undefined };
    expect(() => nativeCreatedSession(missing)).toThrow();
  });
});

test('all locales translate the create action, readiness and failure copy with matching parameters', () => {
  const entries = Object.entries(nativeCreationI18n.en);
  for (const [locale, dictionary] of Object.entries(nativeCreationI18n)) {
    expect(Object.keys(dictionary).sort()).toEqual(entries.map(([key]) => key).sort());
    for (const [key, value] of Object.entries(dictionary)) {
      const english = entries.find(([name]) => name === key)![1];
      expect([...value.matchAll(/\{\w+\}/g)].map(match => match[0]).sort())
        .toEqual([...english.matchAll(/\{\w+\}/g)].map(match => match[0]).sort());
      if (locale !== 'en') expect(value).not.toBe(english);
    }
    const source = readFileSync(new URL(`../i18n/messages/${locale}.ts`, import.meta.url), 'utf8');
    expect(source).toContain('...nativeCreationI18n');
  }
});
