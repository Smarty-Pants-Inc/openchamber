import { afterEach, expect, test } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { failureReport, resetClientErrorReportsForPage } from '@/lib/clientErrorReport';
import { directory, nativeDraftFixture, session } from './native-draft-fixture';

// smarty-code#1058: on 3.59, 12 of 16 session-messages reports said only "Error", with no status, all on just-created
// sessions. A report names the error and its HTTP status; an aborted or superseded read is no failure and not reported.
let fixture: ReturnType<typeof nativeDraftFixture> | undefined;
afterEach(() => { fixture?.dispose(); fixture = undefined; resetClientErrorReportsForPage(); });
const Report = z.object({ kind: z.string(), at: z.number(), message: z.string().optional(), sessionID: z.string().optional(),
  status: z.number().optional() }).strict();
const reports = async () => Promise.all(fixture!.requests
  .filter(request => new URL(request.url).pathname === '/api/client-error')
  .map(async request => Report.parse(await request.json())));
const target = { directory, sessionID: session.id };

test('an aborted history read is not reported', async () => {
  fixture = nativeDraftFixture();
  fixture.handlers.history = async () => { throw new DOMException('The operation was aborted.', 'AbortError'); };
  await fixture.loader.ensure(target, { reason: 'navigation' });
  await sleep(50);
  expect(await reports()).toEqual([]);
});

test('a read superseded by a stream reconnect (its view is stale) is not reported', async () => {
  fixture = nativeDraftFixture();
  const loader = fixture.loader;
  // Every read is overtaken: the stream reconnects while it is out, so its view belongs to the old stream.
  fixture.handlers.history = async () => {
    loader.invalidateOrdinaryViews();
    return Response.json([], { headers: { 'x-smarty-ordinary-view': `ov2_${'b'.repeat(64)}` } });
  };
  await loader.ensure(target, { reason: 'navigation' });
  await sleep(50);
  expect(await reports()).toEqual([]);
});

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

test('an error carrying a status keeps it; an abort anywhere on its cause chain is not a failure', () => {
  expect(failureReport(Object.assign(new Error('boom'), { status: 502 }))).toEqual({ message: 'Error', status: 502 });
  expect(failureReport(new Error('wrapped', { cause: Object.assign(new RangeError('x'), { status: 500 }) })))
    .toEqual({ message: 'RangeError', status: 500 });
  expect(failureReport(Object.assign(new Error('x'), { response: new Response(null, { status: 429 }) })))
    .toEqual({ message: 'Error', status: 429 });
  expect(failureReport(new Error('wrapped', { cause: new DOMException('stop', 'AbortError') }))).toBeNull();
  // A name that is not class-shaped may be content: never sent.
  expect(failureReport(Object.assign(new Error('x'), { name: 'merger plan' }))).toEqual({ message: 'Error', status: undefined });
});
