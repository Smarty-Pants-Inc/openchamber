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

// smarty-code#523 with the gateway's #548: the page asks for stoppedBy on every creation request, and a start that carries
// it parses (the schema is strict, so an unasked field would have failed the whole list).
describe('who stopped a start', () => {
  /** The wire fields these cases vary (an unasked field shows the strict schema dropping the list). */
  type WireExtra = { phase?: string; stoppedBy?: { name: string; issuer?: string; subject?: string; extra?: number } };
  const op = (extra: WireExtra = {}) => ({ operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', directory: '/project',
    generation: null, revision: 3, phase: 'cancelled', expiresAt: 1, canInitialReady: false, ...extra });
  test('creation requests ask for stoppedBy, and a start with it is read', async () => {
    const asked: Array<string | null> = [];
    const stoppedBy = { issuer: 'https://code.example', subject: 'kate-1', name: 'Kate' };
    fetchMock.mockImplementation(async (input, init) => {
      const request = new Request(input, init); asked.push(request.headers.get('x-smarty-creation-fields'));
      return new URL(request.url).pathname.endsWith('/session/creation')
        ? Response.json({ nativeCreations: [op({ stoppedBy })] }) : Response.json({ nativeCreation: op({ stoppedBy }) });
    });
    expect((await opencodeClient.listNativeCreations('/project'))[0]?.stoppedBy).toEqual(stoppedBy);
    expect((await opencodeClient.readNativeCreation('/project', op().operationId)).stoppedBy?.name).toBe('Kate');
    expect((await opencodeClient.abandonNativeCreation('/project', op().operationId)).phase).toBe('cancelled');
    expect(asked).toEqual(['stoppedBy,waitingFor', 'stoppedBy,waitingFor', 'stoppedBy,waitingFor']);
  });
  // smarty-code#768: an expired start says what it waited for (the gateway's #757 reason), and the page reads it.
  test('an expired start with waitingFor is read', async () => {
    fetchMock.mockImplementation(async () => Response.json({ nativeCreations: [{ ...op({ phase: 'expired' }), waitingFor: 'trust not answered' }] }));
    expect((await opencodeClient.listNativeCreations('/project'))[0]?.waitingFor).toBe('trust not answered');
  });
  test('both create paths ask for stoppedBy', async () => {
    const asked: Array<string | null> = [];
    fetchMock.mockImplementation(async (input, init) => {
      asked.push(new Request(input, init).headers.get('x-smarty-creation-fields'));
      return Response.json({ nativeCreation: op({ phase: 'awaiting-trust' }) }, { status: 202 });
    });
    await opencodeClient.createNativeSession('/project');
    await opencodeClient.createNativeSession('/project', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(asked).toEqual(['stoppedBy,waitingFor', 'stoppedBy,waitingFor']);
  });
  test('a malformed stoppedBy is still refused', async () => {
    fetchMock.mockImplementation(async () => Response.json({ nativeCreations: [op({ stoppedBy: { name: 'Kate', extra: 1 } })] }));
    await expect(opencodeClient.listNativeCreations('/project')).rejects.toThrow();
  });
});

// Packaged clients (desktop, Capacitor) call from another origin: a header the page adds must be allowed by the server's
// CORS preflight, or every creation request from them fails (#523 pre-check).
test('the creation-fields header is allowed for packaged clients', () => {
  const server = readFileSync(new URL('../../../../web/server/index.js', import.meta.url), 'utf8');
  const allowed = /Access-Control-Allow-Headers', '([^']+)'/.exec(server)?.[1]?.toLowerCase().split(',') ?? [];
  const client = readFileSync(new URL('./client.ts', import.meta.url), 'utf8');
  const sent = /NATIVE_CREATION_FIELDS = \{ '([^']+)'/.exec(client)?.[1];
  expect(sent).toBe('x-smarty-creation-fields');
  expect(allowed).toContain(sent!);
});
