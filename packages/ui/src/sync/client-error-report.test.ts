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

test('an error toast is reported, once per 30 s', async () => {
  fixture = nativeDraftFixture();
  const { toast } = await import('@/components/ui');
  toast.error('Failed to send message', { description: 'Pi unavailable' });
  toast.error('Failed to send message');
  await sleep(50);
  expect(reports()).toHaveLength(1);
  expect(await reports()[0]!.json()).toMatchObject({ kind: 'toast', message: 'Failed to send message: Pi unavailable' });
});
