import { afterEach, expect, test } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { failureReport, resetClientErrorReportsForPage } from '@/lib/clientErrorReport';
import { directory, nativeDraftFixture, session } from './native-draft-fixture';

// smarty-code#1058: on 3.59, 12 of 16 session-messages reports said only "Error", with no status, all on just-created
// sessions. Reports name current failures and their cause; only owned lifecycle cancellations are silent.
let fixture: ReturnType<typeof nativeDraftFixture> | undefined;
afterEach(() => { fixture?.dispose(); fixture = undefined; resetClientErrorReportsForPage(); });
const Report = z.object({ kind: z.string(), at: z.number(), message: z.string().optional(), sessionID: z.string().optional(),
  status: z.number().optional() }).strict();
const reports = async () => Promise.all(fixture!.requests
  .filter(request => new URL(request.url).pathname === '/api/client-error')
  .map(async request => Report.parse(await request.json())));
const target = { directory, sessionID: session.id };

test('a current read cut mid-body by the read limit (relay tunnel: its own AbortError) fails for the person and is reported (#451 r2)', async () => {
  fixture = nativeDraftFixture();
  // The response head arrived; the tunnel then errors the body stream with its own AbortError when the read limit fires.
  fixture.handlers.history = async () => new Response(new ReadableStream({ start(c) {
    c.enqueue(new TextEncoder().encode('[')); setTimeout(() => c.error(new DOMException('The operation was aborted.', 'AbortError')), 5); } }),
    { headers: { 'content-type': 'application/json', 'x-smarty-ordinary-view': `ov2_${'a'.repeat(64)}` } });
  await fixture.loader.ensure(target, { reason: 'navigation' });
  await sleep(80);
  expect(fixture.loader.getSnapshot(target).status).toBe('error');
  const sent = await reports();
  expect(sent).toHaveLength(1);
  expect(sent[0]!.message).toBe('AbortError (aborted)');
});
test('an abort whose cause is the read limit is named TimeoutError', () => {
  const limit = new DOMException('signal timed out', 'TimeoutError');
  expect(failureReport(new Error('wrapped', { cause: Object.assign(new DOMException('aborted', 'AbortError'), { cause: limit }) })))
    .toEqual({ message: 'TimeoutError (aborted)', status: undefined });
});

test('an unknown current prefetch abort reports its name and aborted cause (#1058)', async () => {
  fixture = nativeDraftFixture();
  fixture.handlers.history = async () => { throw new DOMException('unknown cancellation', 'AbortError'); };
  await fixture.loader.prefetch(target);
  await sleep(50);
  expect(fixture.loader.getSnapshot(target).status).toBe('error');
  expect((await reports()).map(({ kind, message, status }) => ({ kind, message, status })))
    .toEqual([{ kind: 'session-messages.prefetch', message: 'AbortError (aborted)', status: undefined }]);
});

test('a current timeout abort is reported with its cause (#1058)', async () => {
  fixture = nativeDraftFixture();
  fixture.handlers.history = async () => { throw new DOMException('read limit fired', 'TimeoutError'); };
  await fixture.loader.ensure(target, { reason: 'navigation' });
  await sleep(50);
  expect(fixture.loader.getSnapshot(target).status).toBe('error');
  expect((await reports()).map(({ kind, message, status }) => ({ kind, message, status })))
    .toEqual([{ kind: 'session-messages.initial', message: 'TimeoutError (aborted)', status: undefined }]);
});

test('a 503 is reported with its status (#1058)', async () => {
  fixture = nativeDraftFixture();
  fixture.handlers.history = async () => Response.json({ name: 'UnavailableError' }, { status: 503 });
  await fixture.loader.ensure(target, { reason: 'navigation' });
  await sleep(50);
  expect((await reports()).map(({ kind, message, status }) => ({ kind, message, status })))
    .toEqual([{ kind: 'session-messages.initial', message: 'Error', status: 503 }]);
}, 10_000);

test('a timeout cause does not discard HTTP status elsewhere in the chain (#1058)', () => {
  const timeout = new DOMException('read limit fired', 'TimeoutError');
  const abort = Object.assign(new DOMException('aborted', 'AbortError'), { cause: timeout });
  expect(failureReport(Object.assign(new Error('wrapped', { cause: abort }), { status: 503 }), 'fetch'))
    .toEqual({ message: 'TimeoutError', status: 503 });
  Object.assign(timeout, { status: 404 });
  expect(failureReport(new Error('wrapped', { cause: abort }), 'fetch'))
    .toEqual({ message: 'TimeoutError', status: 404 });
});

const staleView = () => Response.json([], { headers: { 'x-smarty-ordinary-view': `ov2_${'b'.repeat(64)}` } });

test('an open whose every read is overtaken by a stream reconnect fails for the person and is reported (r1)', async () => {
  fixture = nativeDraftFixture();
  const loader = fixture.loader;
  let reads = 0;
  // Every read is overtaken: the stream reconnects while it is out, so its view belongs to the old stream. No newer
  // read takes over, so the open uses up its replacement reads and the page shows "Session could not be loaded".
  fixture.handlers.history = async () => { reads++; loader.invalidateOrdinaryViews(); return staleView(); };
  await loader.ensure(target, { reason: 'navigation' });
  await sleep(50);
  expect(reads).toBe(3);
  expect(loader.getSnapshot(target).status).toBe('error');
  expect((await reports()).map(({ kind, message, status, sessionID }) => ({ kind, message, status, sessionID })))
    .toEqual([{ kind: 'session-messages.initial', message: 'SupersededReadError (superseded-exhausted)', status: undefined,
      sessionID: session.id }]);
});

test('a read overtaken once, then answered by its replacement read, is not reported', async () => {
  fixture = nativeDraftFixture();
  const loader = fixture.loader;
  let reads = 0;
  fixture.handlers.history = async () => {
    if (++reads > 1) return Response.json([], { headers: { 'x-smarty-ordinary-view': `ov2_${'c'.repeat(64)}` } });
    loader.invalidateOrdinaryViews();
    return staleView();
  };
  await loader.ensure(target, { reason: 'navigation' });
  await sleep(50);
  expect(loader.getSnapshot(target).status).toBe('ready');
  expect(await reports()).toEqual([]);
});

test('a read superseded by a newer open (a new generation) that succeeds is not reported', async () => {
  fixture = nativeDraftFixture();
  const loader = fixture.loader;
  let reads = 0, newer: Promise<void> | undefined;
  fixture.handlers.history = async () => {
    if (++reads > 1) return Response.json([], { headers: { 'x-smarty-ordinary-view': `ov2_${'c'.repeat(64)}` } });
    // The stream reconnects and the page opens the session again while the first read is out; that read then fails.
    loader.invalidateOrdinaryViews();
    newer = loader.ensure(target, { force: true, reason: 'navigation' });
    throw new TypeError('Failed to fetch');
  };
  await loader.ensure(target, { reason: 'navigation' }).catch(() => undefined);
  await newer;
  await sleep(50);
  expect(loader.getSnapshot(target).status).toBe('ready');
  expect(await reports()).toEqual([]);
}, 10_000);

test('a 404 is reported with its status and the error name', async () => {
  fixture = nativeDraftFixture();
  fixture.handlers.history = async () => Response.json({ name: 'NotFoundError', data: { message: 'gone' } }, { status: 404 });
  await fixture.loader.ensure(target, { reason: 'navigation' });
  await sleep(50);
  expect((await reports()).map(({ kind, message, status }) => ({ kind, message, status })))
    .toEqual([{ kind: 'session-messages.initial', message: 'Error', status: 404 }]);
});

test('a network failure is reported as a TypeError with no HTTP answer', async () => {
  fixture = nativeDraftFixture();
  fixture.handlers.history = async () => { throw new TypeError('Failed to fetch'); };
  await fixture.loader.ensure(target, { reason: 'navigation' });
  await sleep(50);
  expect((await reports()).map(({ kind, message, status }) => ({ kind, message, status })))
    .toEqual([{ kind: 'session-messages.initial', message: 'TypeError (network)', status: undefined }]);
}, 10_000);

test('a malformed page processed after the body read reports TypeError without claiming a network failure (#1125)', async () => {
  fixture = nativeDraftFixture();
  fixture.handlers.history = async () => Response.json([{ info: { id: 'malformed', sessionID: session.id,
    role: 'user', time: { created: 1 } }, parts: {} }]);
  await fixture.loader.ensure(target, { reason: 'navigation' });
  await sleep(50);
  expect(fixture.loader.getSnapshot(target).status).toBe('error');
  expect(fixture.loader.getSnapshot(target).error).toBeInstanceOf(TypeError);
  expect((await reports()).map(({ kind, message, status }) => ({ kind, message, status })))
    .toEqual([{ kind: 'session-messages.initial', message: 'TypeError', status: undefined }]);
});

test('a non-ordinary refresh superseded without replacement reads reports failure without exhaustion (#1125)', async () => {
  fixture = nativeDraftFixture();
  fixture.handlers.history = async () => Response.json([]);
  await fixture.loader.ensure(target, { reason: 'navigation' });
  expect(fixture.loader.getSnapshot(target).status).toBe('ready');
  expect(fixture.loader.isOrdinary(target, fixture.runtimeA)).toBe(false);
  let reads = 0;
  fixture.handlers.history = async () => {
    reads++;
    fixture!.loader.invalidateOrdinaryViews();
    return staleView();
  };
  await fixture.loader.refreshTail(target, 50);
  await sleep(50);
  expect(reads).toBe(1);
  expect(fixture.loader.getSnapshot(target).status).toBe('error');
  expect((await reports()).map(({ kind, message, status }) => ({ kind, message, status })))
    .toEqual([{ kind: 'session-messages.refresh', message: 'SupersededReadError', status: undefined }]);
});

test('a TypeError while reading the response body still reports a network failure (#1125)', async () => {
  fixture = nativeDraftFixture();
  fixture.handlers.history = async () => new Response(new ReadableStream({ start(controller) {
    controller.error(new TypeError('Body stream failed'));
  } }), { headers: { 'content-type': 'application/json' } });
  await fixture.loader.ensure(target, { reason: 'navigation' });
  await sleep(50);
  expect(fixture.loader.getSnapshot(target).status).toBe('error');
  expect((await reports()).map(({ kind, message, status }) => ({ kind, message, status })))
    .toEqual([{ kind: 'session-messages.initial', message: 'TypeError (network)', status: undefined }]);
}, 10_000);

test('network names require fetch provenance and an HTTP status still wins on the cause chain (#1125)', () => {
  const failure = new Error('wrapped', { cause: new TypeError('Failed to fetch') });
  expect(failureReport(failure)).toEqual({ message: 'TypeError', status: undefined });
  expect(failureReport(failure, 'fetch')).toEqual({ message: 'TypeError (network)', status: undefined });
  const httpFailure = new Error('wrapped', { cause: Object.assign(new TypeError('Failed to read'), { status: 502 }) });
  expect(failureReport(httpFailure, 'fetch')).toEqual({ message: 'TypeError', status: 502 });
});
test('an error carrying a status keeps it; a current abort on its cause chain is named, not hidden (#451 r2)', () => {
  expect(failureReport(Object.assign(new Error('boom'), { status: 502 }))).toEqual({ message: 'Error', status: 502 });
  expect(failureReport(new Error('wrapped', { cause: Object.assign(new RangeError('x'), { status: 500 }) })))
    .toEqual({ message: 'RangeError', status: 500 });
  expect(failureReport(Object.assign(new Error('x'), { response: new Response(null, { status: 429 }) })))
    .toEqual({ message: 'Error', status: 429 });
  expect(failureReport(new Error('wrapped', { cause: new DOMException('stop', 'AbortError') }))).toEqual({ message: 'AbortError (aborted)', status: undefined });
  // A name that is not class-shaped may be content: never sent.
  expect(failureReport(Object.assign(new Error('x'), { name: 'merger plan' }))).toEqual({ message: 'Error', status: undefined });
});
