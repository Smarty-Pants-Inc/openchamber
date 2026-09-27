import { afterEach, expect, test } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { resetClientErrorReportsForPage } from '@/lib/clientErrorReport';
import { directory, nativeDraftFixture, session } from './native-draft-fixture';

// smarty-code#536 item 3 (Paul, 3.38): "Session could not be loaded" was shown to him and nothing in the fleet saw it.
// The loader's error path reports what the page shows to the gateway (POST /api/client-error), once per load.
let fixture: ReturnType<typeof nativeDraftFixture> | undefined;
afterEach(() => { fixture?.dispose(); fixture = undefined; resetClientErrorReportsForPage(); });
const reports = () => fixture!.requests.filter(request => new URL(request.url).pathname === '/api/client-error');
// Exactly what the gateway accepts (smarty-code#552): a report with any other field fails the parse.
const Report = z.object({ kind: z.string(), at: z.number(), message: z.string().optional(), sessionID: z.string().optional(),
  status: z.number().optional() }).strict();
const readReport = async (request: Request) => Report.parse(await request.json());
// SAFETY: every fetch double below has fetch's call shape; Bun's fetch type adds preconnect, which the page never uses.
const asFetch = (double: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => double as typeof fetch;

test('a session whose messages cannot be loaded is reported once, with its session and status', async () => {
  fixture = nativeDraftFixture();
  // The server's words may quote the person's content: never reported.
  fixture.handlers.history = async () => Response.json({ name: 'APIError', data: { message: "Refused: 'keep the merger plan private'", isRetryable: false } }, { status: 503 });
  const target = { directory, sessionID: session.id };
  await fixture.loader.ensure(target, { reason: 'navigation' });
  expect(fixture.loader.getSnapshot(target).status).toBe('error'); // What the page shows as "Session could not be loaded".
  await sleep(50); // The report goes out in the background.
  expect(reports()).toHaveLength(1);
  const body = await readReport(reports()[0]!); // Its fields are only those the gateway accepts: no content, no route.
  expect(body).toMatchObject({ kind: 'session-messages.initial', sessionID: session.id, status: 503 });
  expect(body.message).toBe('Error'); // The error's name only, never the server's words.
  expect(JSON.stringify(body).includes('merger')).toBe(false);
  expect(body.at).toBeGreaterThan(0);
  // Shown again (the page re-renders it): the same load, not reported again.
  await fixture.loader.ensure(target, { reason: 'navigation' }).catch(() => undefined);
  await sleep(50);
  expect(reports()).toHaveLength(1);
  // A new attempt (Try again) is a new operation: its failure reports.
  await fixture.loader.ensure(target, { reason: 'navigation', force: true });
  await sleep(50);
  expect(reports()).toHaveLength(2);
});

test('a history open that timed out is reported as a timeout, with its session', async () => {
  fixture = nativeDraftFixture();
  fixture.handlers.history = async () => { throw new Error('OpenCode request timed out after 30000ms'); };
  await fixture.loader.ensure({ directory, sessionID: session.id }, { reason: 'navigation' });
  await sleep(50);
  const bodies = await Promise.all(reports().map(readReport));
  expect(bodies.map(body => [body.kind, body.sessionID])).toEqual([['session-messages.initial.timeout', session.id]]);
});

test('a load that succeeds reports nothing', async () => {
  fixture = nativeDraftFixture();
  await fixture.loader.ensure({ directory, sessionID: session.id }, { reason: 'navigation' });
  await sleep(50);
  expect(reports()).toHaveLength(0);
});

test('a generic error toast does not report: its operation\'s server is not known where it shows', async () => {
  fixture = nativeDraftFixture();
  const { toast } = await import('@/components/ui');
  toast.error('No commits found in range main...feature/merger');
  await sleep(50);
  expect(reports()).toHaveLength(0);
});

test('a report is redacted: no query strings, tokens, addresses, quoted text, file names or paths', async () => {
  const { redactClientError } = await import('@/lib/clientErrorReport');
  expect(redactClientError('Failed https://code.example/api/x?token=abc for paul@example.com with sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ123'))
    .toBe('Failed https://code.example/api/x for <email> with <redacted>');
  expect(redactClientError('Could not rename "Merger plan for Friday" session')).toBe('Could not rename "…" session');
  expect(redactClientError('File "payroll.csv" is too large (max 10MB)')).toBe('File "…" is too large (max 10MB)');
  expect(redactClientError('Failed to attach payroll.xlsx')).toBe('Failed to attach <file>');
  expect(redactClientError('Cannot read /home/paul/secret/notes.md: denied')).toBe('Cannot read <path>: denied');
});

test('a report made for one server is never sent after a switch to another', async () => {
  fixture = nativeDraftFixture();
  const { reportClientError } = await import('@/lib/clientErrorReport');
  const { switchRuntimeEndpoint, getRuntimeKey } = await import('@/lib/runtime-switch');
  const runtimeA = getRuntimeKey();
  switchRuntimeEndpoint({ apiBaseUrl: 'http://synthetic.invalid', runtimeKey: `other-${crypto.randomUUID()}` });
  reportClientError({ kind: 'fork', operationId: 'op-a', runtimeKey: runtimeA, sessionID: 'ses_a' }); // A's, late.
  await sleep(50);
  expect(reports()).toHaveLength(0);
  switchRuntimeEndpoint({ apiBaseUrl: 'http://synthetic.invalid', runtimeKey: runtimeA });
});

// Review of #301 (P1): a failure is reported only to the server its operation belonged to, captured before its first
// await. A fork that fails after the page switched from server A to B is reported nowhere; never to B with B's token.
test('a fork that fails after a switch to another server is reported nowhere; without a switch, to its own server', async () => {
  fixture = nativeDraftFixture();
  const { forkFromMessage } = await import('./session-actions');
  const { switchRuntimeEndpoint, getRuntimeKey } = await import('@/lib/runtime-switch');
  const seen: Array<{ runtime: string; path: string }> = [];
  let release = () => {};
  const forkHeld = () => new Promise<void>(resolve => { release = resolve; });
  const served = globalThis.fetch;
  let hold: Promise<void> | undefined;
  globalThis.fetch = asFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    if (path.endsWith('/client-error')) { seen.push({ runtime: getRuntimeKey(), path }); return new Response(null, { status: 204 }); }
    if (path.endsWith('/fork')) { if (hold) await hold; return Response.json({ name: 'APIError', data: { message: 'fork refused', isRetryable: false } }, { status: 500 }); }
    return served(input, init);
  });
  try {
    const runtimeA = getRuntimeKey();
    // With a switch: the fork is sent on A, A goes away while it is out, then it fails.
    hold = forkHeld();
    const failing = forkFromMessage(session.id, 'msg_1').catch(() => undefined);
    await sleep(10);
    switchRuntimeEndpoint({ apiBaseUrl: 'http://synthetic.invalid', runtimeKey: `server-b-${crypto.randomUUID()}` });
    release(); await failing; await sleep(50);
    expect(seen).toEqual([]); // Nowhere: never B.
    // Without a switch: back on A, the same failure is reported to A.
    switchRuntimeEndpoint({ apiBaseUrl: 'http://synthetic.invalid', runtimeKey: runtimeA });
    hold = undefined;
    await forkFromMessage(session.id, 'msg_2').catch(() => undefined); await sleep(50);
    expect(seen).toEqual([{ runtime: runtimeA, path: '/api/client-error' }]);
  } finally { globalThis.fetch = served; }
});

// Review 5854916574: every report is scoped to the server its operation STARTED on. A small-model request begun on A that
// fails after the switch to B goes nowhere; one begun on B reports to B, once.
test('a small-model request begun on A that fails after the switch is dropped; one begun on B reports to B once', async () => {
  fixture = nativeDraftFixture();
  const { requestSmallModel } = await import('@/lib/smallModelRequest');
  const { switchRuntimeEndpoint, getRuntimeKey } = await import('@/lib/runtime-switch');
  const runtimeA = getRuntimeKey();
  const served = globalThis.fetch;
  const seen: Array<{ runtime: string; kind: string; status: unknown }> = [];
  let releaseA: (() => void) | undefined;
  globalThis.fetch = asFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    if (path.endsWith('/client-error')) { const body = await request.json(); seen.push({ runtime: getRuntimeKey(), kind: String(body.kind), status: body.status }); return new Response(null, { status: 204 }); }
    if (path.endsWith('/small-model/generate')) {
      if (!releaseA) { await new Promise<void>(resolve => { releaseA = resolve; }); }
      return Response.json({ error: 'no model' }, { status: 503 });
    }
    return served(input, init);
  });
  try {
    const onA = requestSmallModel({ method: 'POST', body: '{}' }); // Begun on A, held.
    await sleep(10);
    const runtimeB = `server-b-${crypto.randomUUID()}`;
    switchRuntimeEndpoint({ apiBaseUrl: 'http://synthetic.invalid', runtimeKey: runtimeB });
    await requestSmallModel({ method: 'POST', body: '{}' }); await sleep(50); // Begun on B, fails: reported to B.
    releaseA!(); await onA; await sleep(50); // A's fails now: dropped.
    expect(seen).toEqual([{ runtime: runtimeB, kind: 'small-model', status: 503 }]);
  } finally { globalThis.fetch = served; }
  switchRuntimeEndpoint({ apiBaseUrl: 'http://synthetic.invalid', runtimeKey: runtimeA });
});

// Review 5854916574: deduplicated per error (kind, operation), never per task or session.
test('two distinct errors in one batch each report; the same error seen twice reports once', async () => {
  fixture = nativeDraftFixture();
  const { reportClientError } = await import('@/lib/clientErrorReport');
  const { getRuntimeKey } = await import('@/lib/runtime-switch');
  const runtimeKey = getRuntimeKey();
  // One synchronous event batch: a steer not delivered, then the same session's turn settled locally.
  reportClientError({ kind: 'steer.not-delivered', operationId: 'msg_1', sessionID: session.id, runtimeKey });
  reportClientError({ kind: 'turn-settled-locally', operationId: `${session.id}:msg_2`, sessionID: session.id, runtimeKey, message: 'idle; tools interrupted: 2' });
  reportClientError({ kind: 'steer.not-delivered', operationId: 'msg_1', sessionID: session.id, runtimeKey }); // Shown again.
  reportClientError({ kind: 'settings-save', operationId: 'save-1', runtimeKey }); // Sessionless, unrelated.
  await sleep(50);
  const kinds = await Promise.all(reports().map(async request => String((await request.json()).kind)));
  expect(kinds).toEqual(['steer.not-delivered', 'turn-settled-locally', 'settings-save']);
});

test('an unhandled error reports page.unhandled with its name only; an event without an error object does not', async () => {
  fixture = nativeDraftFixture();
  const { listenForUnhandledErrors } = await import('@/lib/clientErrorReport');
  const target = new EventTarget();
  listenForUnhandledErrors(target);
  type Fired = { error?: Error | null; reason?: Error | { name: string }; message?: string };
  const fire = (type: string, detail: Fired) => { target.dispatchEvent(Object.assign(new Event(type), detail)); };
  fire('error', { error: new TypeError("Cannot read 'merger plan'") });
  fire('unhandledrejection', { reason: new RangeError('payroll.xlsx too big') });
  fire('error', { error: null, message: 'ResizeObserver loop completed' });
  fire('unhandledrejection', { reason: { name: 'PayrollSecret' } }); // Not an Error: may be anything.
  fire('error', { error: Object.assign(new Error('x'), { name: 'MergerPlanError' }) }); // A custom name: 'Error'.
  fire('error', { error: new TypeError('again') }); // The same name within 30 s: not again.
  await sleep(50);
  const bodies = await Promise.all(reports().map(readReport));
  expect(bodies.map(body => [body.kind, body.message])).toEqual([['page.unhandled', 'TypeError'], ['page.unhandled', 'RangeError'], ['page.unhandled', 'Error']]);
  expect(/merger|payroll/i.test(JSON.stringify(bodies))).toBe(false);
});

test('a failed context pin and a failed OpenCode upgrade each report their own code and status', async () => {
  fixture = nativeDraftFixture();
  const { setContextObligatoryMessage } = await import('./session-actions');
  const { runtimeFetch } = await import('@/lib/runtime-fetch');
  const served = globalThis.fetch;
  const kinds: string[] = [];
  globalThis.fetch = asFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    if (path.endsWith('/client-error')) { const body = await request.json(); kinds.push(`${body.kind}:${body.status ?? ''}`); return new Response(null, { status: 204 }); }
    if (request.method === 'PATCH' || path.endsWith('/opencode/upgrade')) return Response.json({ error: 'refused' }, { status: 500 });
    return served(input, init);
  });
  try {
    await setContextObligatoryMessage(session.id, directory, { id: 'msg_1', createdAt: 1, role: 'user' }, true).catch(() => undefined);
    await sleep(0); // The upgrade is a separate failure, in its own task.
    await runtimeFetch('/api/opencode/upgrade', { method: 'POST', body: '{}' });
    await sleep(50);
    expect(kinds.sort()).toEqual(['context-pin:', 'opencode-upgrade:500']);
    // A 200 that says it did not succeed, and a request that never got an answer, are failures too.
    const { resetClientErrorReportsForPage } = await import('@/lib/clientErrorReport');
    resetClientErrorReportsForPage(); kinds.length = 0;
    globalThis.fetch = asFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init), path = new URL(request.url).pathname;
      if (path.endsWith('/client-error')) { const body = await request.json(); kinds.push(`${body.kind}:${body.status ?? ''}`); return new Response(null, { status: 204 }); }
      return Response.json({ success: false, error: 'npm refused' }, { status: 200 });
    });
    await runtimeFetch('/api/opencode/upgrade', { method: 'POST', body: '{}' }); await sleep(50);
    expect(kinds).toEqual(['opencode-upgrade:200']);
    resetClientErrorReportsForPage(); kinds.length = 0;
    globalThis.fetch = asFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init), path = new URL(request.url).pathname;
      if (path.endsWith('/client-error')) { const body = await request.json(); kinds.push(`${body.kind}:${body.status ?? ''}`); return new Response(null, { status: 204 }); }
      throw new TypeError('Failed to fetch');
    });
    await runtimeFetch('/api/opencode/upgrade', { method: 'POST', body: '{}' }).catch(() => undefined); await sleep(50);
    expect(kinds).toEqual(['opencode-upgrade:']);
  } finally { globalThis.fetch = served; }
});
