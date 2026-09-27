import { afterEach, expect, test } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { resetClientErrorReportsForPage } from '@/lib/clientErrorReport';
import { directory, nativeDraftFixture, session } from './native-draft-fixture';

// smarty-code#536 item 3 (Paul, 3.38): "Session could not be loaded" was shown to him and nothing in the fleet saw it.
// The loader's error path reports what the page shows to the gateway (POST /api/client-error), once per 30 s per kind.
let fixture: ReturnType<typeof nativeDraftFixture> | undefined;
afterEach(() => { fixture?.dispose(); fixture = undefined; resetClientErrorReportsForPage(); });
const reports = () => fixture!.requests.filter(request => new URL(request.url).pathname === '/api/client-error');

test('a session whose messages cannot be loaded is reported once, with its session and status', async () => {
  fixture = nativeDraftFixture();
  fixture.handlers.history = async () => Response.json({ name: 'APIError', data: { message: 'Pi unavailable', isRetryable: false } }, { status: 503 });
  const target = { directory, sessionID: session.id };
  await fixture.loader.ensure(target, { reason: 'navigation' });
  expect(fixture.loader.getSnapshot(target).status).toBe('error'); // What the page shows as "Session could not be loaded".
  await sleep(50); // The report goes out in the background.
  expect(reports()).toHaveLength(1);
  const body = await reports()[0]!.json() as Record<string, unknown>;
  expect(body).toMatchObject({ kind: 'session-messages.initial', sessionID: session.id, status: 503 });
  expect(typeof body.message).toBe('string');
  expect(typeof body.at).toBe('number');
  for (const key of Object.keys(body)) expect(['at', 'kind', 'message', 'route', 'sessionID', 'status']).toContain(key); // No content.
  // The same failure again within 30 s: shown again, not reported again.
  await fixture.loader.ensure(target, { reason: 'navigation', force: true });
  expect(fixture.loader.getSnapshot(target).status).toBe('error');
  await sleep(50);
  expect(reports()).toHaveLength(1);
});

test('a load that succeeds reports nothing', async () => {
  fixture = nativeDraftFixture();
  await fixture.loader.ensure({ directory, sessionID: session.id }, { reason: 'navigation' });
  await sleep(50);
  expect(reports()).toHaveLength(0);
});

test('an error toast is reported once per 30 s for the same error; a different error is its own report', async () => {
  fixture = nativeDraftFixture();
  const { toast } = await import('@/components/ui');
  toast.error('Failed to send message', { description: 'Pi unavailable' });
  toast.error('Failed to send message', { description: 'Pi unavailable' });
  toast.error('Project changes were not saved');
  await sleep(50);
  const bodies = await Promise.all(reports().map(request => request.json() as Promise<Record<string, unknown>>));
  expect(bodies.map(body => [body.kind, body.message])).toEqual([
    ['toast', 'Failed to send message: Pi unavailable'], ['toast', 'Project changes were not saved']]);
});

test('a report is redacted: no query strings, tokens or addresses, and the route is a template', async () => {
  const { redactClientError } = await import('@/lib/clientErrorReport');
  expect(redactClientError('Failed https://code.example/api/x?token=abc for paul@example.com with sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ123'))
    .toBe('Failed https://code.example/api/x for <email> with <redacted>');
  expect(redactClientError('Could not rename "Merger plan for Friday" session')).toBe('Could not rename "…" session');
});

test('a report made for one server is never sent after a switch to another', async () => {
  fixture = nativeDraftFixture();
  const { reportClientError } = await import('@/lib/clientErrorReport');
  const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
  reportClientError({ kind: 'toast', message: 'shown for A', sessionID: 'ses_a' });
  switchRuntimeEndpoint({ apiBaseUrl: 'http://synthetic.invalid', runtimeKey: `other-${crypto.randomUUID()}` });
  await sleep(50);
  expect(reports()).toHaveLength(0);
});
